#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { browserManager } from "./browser.js";
import { config } from "./config.js";
import { saveImage, type SavedFile } from "./files.js";
import { jobManager, type Job } from "./jobs.js";
import { getLogger } from "./logger.js";
import { getProvider, providerNames } from "./providers/registry.js";
import type { CapturedImage } from "./providers/types.js";

const log = getLogger("server");

const providerSchema = z.enum(["chatgpt", "gemini"]).describe("Which web provider to use");
const aspectSchema = z
  .string()
  .regex(/^\d{1,2}:\d{1,2}$/)
  .optional()
  .describe('Desired aspect ratio like "16:9", "1:1", "9:16". Folded into the prompt (web UIs have no direct control), so verify the result visually.');
const waitSchema = z
  .number()
  .int()
  .min(5)
  .max(590)
  .optional()
  .describe("Seconds to wait inline before returning a job id for polling (default 150)");

interface JobView {
  job_id: string;
  provider: string;
  status: string;
  prompt: string;
  files?: Array<{
    absolute_path: string;
    relative_path: string;
    bytes: number;
    content_type: string;
    capture_method: string;
  }>;
  error?: string;
  next_step: string;
  logs: string[];
}

function jobView(job: Job): JobView {
  const view: JobView = {
    job_id: job.id,
    provider: job.provider,
    status: job.status,
    prompt: job.prompt,
    next_step:
      job.status === "completed"
        ? "Read the saved file(s) with your vision capabilities and judge whether the image matches the request (composition, artifacts, hands/faces, aspect ratio, unwanted text/watermarks). Regenerate with an improved prompt if not."
        : job.status === "failed"
          ? "Inspect the error; fix the cause (e.g. run provider_login) or retry, possibly with a rephrased prompt."
          : `Still generating. Poll get_generation_status with job_id "${job.id}".`,
    logs: job.logs.slice(-15),
  };
  if (job.files.length > 0) {
    view.files = job.files.map((f, i) => ({
      absolute_path: f.absolutePath,
      relative_path: f.relativePath,
      bytes: f.bytes,
      content_type: f.contentType,
      capture_method: job.captureMethods[i] ?? "download",
    }));
  }
  if (job.error) view.error = job.error;
  return view;
}

function jsonResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  return jsonResult({ error: message }, true);
}

/** Start a generation/edit job that saves its own output on completion. */
function startJob(opts: {
  provider: string;
  kind: "generate" | "edit";
  prompt: string;
  aspectRatio?: string;
  inputImagePath?: string;
  outputPath: string;
  filename?: string;
  overwrite?: boolean;
}): Job {
  const provider = getProvider(opts.provider);
  return jobManager.create(opts.provider, opts.kind, opts.prompt, async (job) => {
    const jobLog = (m: string) => {
      job.logs.push(`${new Date().toISOString()} ${m}`);
      log.info(`[${job.id}] ${m}`);
    };
    const captured: CapturedImage[] = await provider.generate({
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      inputImagePath: opts.inputImagePath,
      timeoutMs: config.generationTimeoutMs,
      log: jobLog,
    });
    const files: SavedFile[] = [];
    const captureMethods: string[] = [];
    for (const [i, image] of captured.entries()) {
      const stem = `${opts.provider}-${Date.now()}${captured.length > 1 ? `-${i + 1}` : ""}`;
      const saved = await saveImage(
        {
          outputPath: opts.outputPath,
          filename: i === 0 ? opts.filename : undefined,
          defaultStem: stem,
          contentType: image.contentType,
          overwrite: opts.overwrite,
        },
        image.buffer
      );
      files.push(saved);
      captureMethods.push(image.captureMethod);
      jobLog(`Saved ${saved.bytes} bytes to ${saved.absolutePath} (${image.captureMethod})`);
    }
    return { files, captureMethods };
  });
}

const server = new McpServer({ name: "pixel-bridge-mcp", version: "0.1.0" });

server.registerTool(
  "generate_image",
  {
    description:
      "Generate an image via a logged-in web provider (ChatGPT web or Gemini web) and save it locally. " +
      "Waits inline up to wait_seconds; if generation is still running, returns a job_id to poll with get_generation_status. " +
      "The MCP does NOT judge quality — after completion, you (the caller) should view the saved file and decide whether to keep it or regenerate with a better prompt.",
    inputSchema: {
      provider: providerSchema,
      prompt: z.string().min(1).describe("The image description to send to the provider"),
      output_path: z
        .string()
        .describe("Target file (e.g. ./assets/hero.png) or directory. Directories are created automatically; existing files are never overwritten unless overwrite=true — a -1/-2 suffix is added instead."),
      aspect_ratio: aspectSchema,
      filename: z.string().optional().describe("Filename to use when output_path is a directory"),
      overwrite: z.boolean().optional().describe("Allow replacing an existing file (default false)"),
      wait_seconds: waitSchema,
    },
  },
  async (args) => {
    try {
      const job = startJob({
        provider: args.provider,
        kind: "generate",
        prompt: args.prompt,
        aspectRatio: args.aspect_ratio,
        outputPath: args.output_path,
        filename: args.filename,
        overwrite: args.overwrite,
      });
      const settled = await jobManager.waitFor(job.id, (args.wait_seconds ?? config.defaultWaitMs / 1000) * 1000);
      return jsonResult(jobView(settled), settled.status === "failed");
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "edit_image",
  {
    description:
      "Edit an existing local image via a logged-in web provider: uploads the image, sends the edit instructions, and saves the edited result locally. Same job semantics as generate_image.",
    inputSchema: {
      provider: providerSchema,
      input_image_path: z.string().describe("Path to the local image to edit"),
      instructions: z.string().min(1).describe("What to change in the image"),
      output_path: z.string().describe("Target file or directory for the edited image"),
      filename: z.string().optional(),
      overwrite: z.boolean().optional(),
      wait_seconds: waitSchema,
    },
  },
  async (args) => {
    try {
      const job = startJob({
        provider: args.provider,
        kind: "edit",
        prompt: args.instructions,
        inputImagePath: path.resolve(args.input_image_path),
        outputPath: args.output_path,
        filename: args.filename,
        overwrite: args.overwrite,
      });
      const settled = await jobManager.waitFor(job.id, (args.wait_seconds ?? config.defaultWaitMs / 1000) * 1000);
      return jsonResult(jobView(settled), settled.status === "failed");
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "generate_with_both",
  {
    description:
      "Generate the same concept with BOTH providers (ChatGPT web + Gemini web) in parallel and save both images locally, so you can visually compare them and pick the winner. Each provider can succeed or fail independently.",
    inputSchema: {
      prompt: z.string().min(1),
      output_path: z.string().describe("Directory (recommended) or file-path stem where both images are saved"),
      aspect_ratio: aspectSchema,
      wait_seconds: waitSchema,
    },
  },
  async (args) => {
    try {
      const waitMs = (args.wait_seconds ?? config.defaultWaitMs / 1000) * 1000;
      const jobs = providerNames().map((name) =>
        startJob({
          provider: name,
          kind: "generate",
          prompt: args.prompt,
          aspectRatio: args.aspect_ratio,
          outputPath: args.output_path,
          filename: undefined,
        })
      );
      const settled = await Promise.all(jobs.map((j) => jobManager.waitFor(j.id, waitMs)));
      const anyCompleted = settled.some((j) => j.status === "completed");
      return jsonResult(
        {
          results: settled.map(jobView),
          next_step: anyCompleted
            ? "View each saved image, compare them against the request, and keep the better one (or regenerate with an improved prompt if neither is good)."
            : "No provider has finished yet or all failed — check statuses/errors above.",
        },
        settled.every((j) => j.status === "failed")
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_generation_status",
  {
    description:
      "Check a generation/edit job started by generate_image, edit_image or generate_with_both. Returns status, saved file paths when finished, error details on failure, and recent job logs.",
    inputSchema: {
      job_id: z.string().describe("The job_id returned by a generation tool"),
      wait_seconds: z.number().int().min(0).max(590).optional().describe("Optionally block up to this many seconds for the job to finish (default 0 = return current state)"),
    },
  },
  async (args) => {
    try {
      const job = args.wait_seconds
        ? await jobManager.waitFor(args.job_id, args.wait_seconds * 1000)
        : jobManager.get(args.job_id);
      if (!job) throw new Error(`Unknown job id: ${args.job_id}`);
      return jsonResult(jobView(job), job.status === "failed");
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "download_generated_image",
  {
    description:
      "Copy a completed job's image(s) to an additional location. Note: jobs already save their output to the originally requested path automatically — use this only to place an extra copy somewhere else.",
    inputSchema: {
      job_id: z.string(),
      output_path: z.string().describe("File or directory for the copy"),
      filename: z.string().optional(),
      overwrite: z.boolean().optional(),
    },
  },
  async (args) => {
    try {
      const job = jobManager.get(args.job_id);
      if (!job) throw new Error(`Unknown job id: ${args.job_id}`);
      if (job.status !== "completed") {
        return jsonResult(jobView(job), job.status === "failed");
      }
      const fs = await import("node:fs/promises");
      const copies = [];
      for (const [i, file] of job.files.entries()) {
        const data = await fs.readFile(file.absolutePath);
        const saved = await saveImage(
          {
            outputPath: args.output_path,
            filename: i === 0 ? args.filename : undefined,
            defaultStem: `${job.provider}-${job.id}${job.files.length > 1 ? `-${i + 1}` : ""}`,
            contentType: file.contentType,
            overwrite: args.overwrite,
          },
          data
        );
        copies.push({ absolute_path: saved.absolutePath, relative_path: saved.relativePath, bytes: saved.bytes });
      }
      return jsonResult({ job_id: job.id, copies });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "check_provider_session",
  {
    description:
      "Check whether the persistent browser session for a provider is authenticated and usable. Never enters credentials — if not authenticated, it tells you to run provider_login so the user can log in manually.",
    inputSchema: { provider: providerSchema },
  },
  async (args) => {
    try {
      const status = await getProvider(args.provider).checkSession();
      return jsonResult(status, !status.authenticated);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "provider_login",
  {
    description:
      "Open the provider's website in the (headed) persistent browser and WAIT for the user to log in manually — including any CAPTCHA or MFA, which are never automated. Ask the user to complete the login in the opened window; returns once login is detected or the wait times out. Requires the server to run with PIXEL_BRIDGE_HEADLESS unset/false.",
    inputSchema: {
      provider: providerSchema,
      wait_seconds: z.number().int().min(10).max(590).optional().describe("How long to wait for manual login (default 300)"),
    },
  },
  async (args) => {
    try {
      if (config.headless && !config.cdpUrl) {
        return jsonResult(
          {
            error:
              "The server is running headless (PIXEL_BRIDGE_HEADLESS), so the user cannot see the login window. Restart the MCP server without headless mode, then retry.",
          },
          true
        );
      }
      const status = await getProvider(args.provider).waitForLogin(
        (args.wait_seconds ?? config.loginTimeoutMs / 1000) * 1000
      );
      return jsonResult(status, !status.authenticated);
    } catch (err) {
      return errorResult(err);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(
    `pixel-bridge-mcp started. Providers: ${providerNames().join(", ")}. Profiles: ${config.profilesDir}. Headless: ${config.headless}.`
  );

  const shutdown = async () => {
    log.info("Shutting down…");
    await browserManager.closeAll().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
