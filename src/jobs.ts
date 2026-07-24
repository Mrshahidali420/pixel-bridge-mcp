import crypto from "node:crypto";
import { getLogger } from "./logger.js";
import type { SavedFile } from "./files.js";

const log = getLogger("jobs");

export type JobStatus = "running" | "completed" | "failed";

export interface Job {
  id: string;
  provider: string;
  kind: "generate" | "edit";
  prompt: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  /** Files are saved by the job itself, so results survive client timeouts. */
  files: SavedFile[];
  /** Extra per-image metadata aligned with `files`. */
  captureMethods: string[];
  error?: string;
  logs: string[];
}

/**
 * Generations run as background jobs. generate_image waits inline for a
 * while; if the site is slow, the caller gets a job id back and polls with
 * get_generation_status. The job keeps writing the image to disk on
 * completion either way — a client timeout never loses a finished image.
 */
class JobManager {
  private jobs = new Map<string, Job>();
  private promises = new Map<string, Promise<void>>();

  create(
    provider: string,
    kind: Job["kind"],
    prompt: string,
    runner: (job: Job) => Promise<{ files: SavedFile[]; captureMethods: string[] }>
  ): Job {
    const job: Job = {
      id: `job_${crypto.randomBytes(6).toString("hex")}`,
      provider,
      kind,
      prompt,
      status: "running",
      createdAt: new Date().toISOString(),
      files: [],
      captureMethods: [],
      logs: [],
    };
    this.jobs.set(job.id, job);

    const promise = runner(job)
      .then((result) => {
        job.files = result.files;
        job.captureMethods = result.captureMethods;
        job.status = "completed";
        job.finishedAt = new Date().toISOString();
        log.info(`${job.id} completed: ${result.files.map((f) => f.absolutePath).join(", ")}`);
      })
      .catch((err: unknown) => {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = new Date().toISOString();
        log.error(`${job.id} failed: ${job.error}`);
      });
    this.promises.set(job.id, promise);

    // Keep memory bounded: drop finished jobs older than the newest 100.
    if (this.jobs.size > 100) {
      const finished = [...this.jobs.values()]
        .filter((j) => j.status !== "running")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const old of finished.slice(0, this.jobs.size - 100)) {
        this.jobs.delete(old.id);
        this.promises.delete(old.id);
      }
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Wait until the job settles or `ms` elapses; returns the job either way. */
  async waitFor(id: string, ms: number): Promise<Job> {
    const job = this.jobs.get(id);
    const promise = this.promises.get(id);
    if (!job || !promise) throw new Error(`Unknown job id: ${id}`);
    await Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
    return job;
  }
}

export const jobManager = new JobManager();
