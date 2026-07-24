import fs from "node:fs";
import { type Locator, type Page } from "playwright";
import { browserManager } from "../browser.js";
import { getLogger, screenshotPath } from "../logger.js";
import type {
  CapturedImage,
  GenerateRequest,
  ImageProvider,
  ProviderName,
  SessionStatus,
} from "./types.js";

/** Ignore tiny images (avatars, icons, UI chrome). */
const MIN_IMAGE_DIMENSION = 300;
const POLL_MS = 2000;

export interface PageImage {
  src: string;
  width: number;
  height: number;
  alt: string;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly kind:
    | "not_authenticated"
    | "timeout"
    | "refused"
    | "ui_changed"
    | "capture_failed") {
    super(message);
  }
}

/**
 * Shared browser choreography for chat-style image generators. Subclasses
 * supply URLs, selector candidate lists and login/busy detection; everything
 * here avoids hard dependence on any single selector by trying candidates in
 * order and by detecting results via "a new large image appeared" rather than
 * provider-specific DOM structure.
 */
export abstract class BaseChatProvider implements ImageProvider {
  abstract readonly name: ProviderName;
  /** URL that opens a fresh conversation. */
  protected abstract readonly newChatUrl: string;
  /** Candidate selectors for the prompt composer, tried in order. */
  protected abstract readonly composerSelectors: string[];
  /** Candidate selectors for the send button (Enter is the fallback). */
  protected abstract readonly sendSelectors: string[];
  /** Substrings that mark an <img src> as generated content for this provider. */
  protected abstract readonly imageSrcMarkers: string[];
  /** Returns true when the page shows a logged-in UI. */
  protected abstract detectAuthenticated(page: Page): Promise<boolean>;
  /** Returns true while the model is still responding/generating. */
  protected abstract detectBusy(page: Page): Promise<boolean>;
  /** Provider-specific phrasing that reliably triggers image generation. */
  protected abstract buildPrompt(req: GenerateRequest): string;

  protected log = getLogger(this.constructor.name);

  // ---------- session ----------

  async checkSession(): Promise<SessionStatus> {
    return browserManager.withProvider(this.name, async (page) => {
      await this.gotoFresh(page);
      const authenticated = await this.detectAuthenticated(page);
      return {
        provider: this.name,
        authenticated,
        url: page.url(),
        details: authenticated
          ? "Session is authenticated and the composer is reachable."
          : `Not logged in. Run the provider_login tool (or start the server headed and log in at ${this.newChatUrl}), completing any CAPTCHA/MFA yourself.`,
      };
    });
  }

  async waitForLogin(timeoutMs: number): Promise<SessionStatus> {
    return browserManager.withProvider(this.name, async (page) => {
      await this.gotoFresh(page);
      const deadline = Date.now() + timeoutMs;
      let authenticated = await this.detectAuthenticated(page);
      while (!authenticated && Date.now() < deadline) {
        await page.waitForTimeout(3000);
        authenticated = await this.detectAuthenticated(page).catch(() => false);
      }
      return {
        provider: this.name,
        authenticated,
        url: page.url(),
        details: authenticated
          ? "Login detected. The persistent profile will keep this session for future runs."
          : "Login was not completed before the timeout. The window stays open — finish logging in and run check_provider_session again.",
      };
    });
  }

  // ---------- generation ----------

  async generate(req: GenerateRequest): Promise<CapturedImage[]> {
    return browserManager.withProvider(this.name, async (page) => {
      try {
        return await this.generateOnPage(page, req);
      } catch (err) {
        // Always leave a screenshot behind for debugging, then rethrow.
        try {
          const shot = screenshotPath(`${this.name}-failure`);
          await page.screenshot({ path: shot, fullPage: false });
          req.log(`Failure screenshot saved to ${shot}`);
        } catch {
          /* screenshot is best-effort */
        }
        throw err;
      }
    });
  }

  private async generateOnPage(page: Page, req: GenerateRequest): Promise<CapturedImage[]> {
    await this.gotoFresh(page);

    if (!(await this.detectAuthenticated(page))) {
      throw new ProviderError(
        `${this.name} session is not authenticated. Use the provider_login tool and log in manually.`,
        "not_authenticated"
      );
    }

    if (req.inputImagePath) {
      await this.uploadImage(page, req);
    }

    const before = await this.collectImages(page);
    const beforeSrcs = new Set(before.map((i) => i.src));
    req.log(`Baseline: ${beforeSrcs.size} large image(s) already on page`);

    const prompt = this.buildPrompt(req);
    await this.typePrompt(page, prompt, req);
    await this.submit(page, req);
    req.log("Prompt submitted, waiting for generation…");

    const images = await this.waitForNewImages(page, beforeSrcs, req);
    req.log(`Detected ${images.length} new image(s), capturing…`);

    const captured: CapturedImage[] = [];
    for (const img of images) {
      captured.push(await this.captureImage(page, img, req));
    }
    if (captured.length === 0) {
      throw new ProviderError("No image could be captured from the page.", "capture_failed");
    }
    return captured;
  }

  protected async gotoFresh(page: Page): Promise<void> {
    await page.goto(this.newChatUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // Give SPAs a moment to hydrate; networkidle is unreliable on chat apps.
    await page.waitForTimeout(3000);
  }

  protected async findFirst(page: Page, selectors: string[]): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  }

  protected async typePrompt(page: Page, prompt: string, req: GenerateRequest): Promise<void> {
    const composer = await this.findFirst(page, this.composerSelectors);
    if (!composer) {
      throw new ProviderError(
        `Could not find the prompt composer on ${this.name} (tried: ${this.composerSelectors.join(", ")}). The UI may have changed.`,
        "ui_changed"
      );
    }
    await composer.click();
    // insertText works for both <textarea> and contenteditable, and avoids
    // per-character typing quirks / markdown auto-formatting.
    await page.keyboard.insertText(prompt);
    req.log(`Prompt entered (${prompt.length} chars)`);
  }

  protected async submit(page: Page, req: GenerateRequest): Promise<void> {
    const send = await this.findFirst(page, this.sendSelectors);
    if (send) {
      await send.click();
    } else {
      req.log("Send button not found; falling back to Enter");
      await page.keyboard.press("Enter");
    }
  }

  protected async uploadImage(page: Page, req: GenerateRequest): Promise<void> {
    const inputPath = req.inputImagePath!;
    if (!fs.existsSync(inputPath)) {
      throw new ProviderError(`Input image not found: ${inputPath}`, "capture_failed");
    }
    // Most chat UIs keep a hidden <input type=file> wired up permanently.
    const fileInput = page.locator('input[type="file"]').first();
    try {
      await fileInput.setInputFiles(inputPath, { timeout: 10_000 });
    } catch {
      throw new ProviderError(
        `Could not find a file-upload input on ${this.name}; the edit flow may need a UI update.`,
        "ui_changed"
      );
    }
    req.log(`Uploaded ${inputPath}, waiting for the attachment to process…`);
    await page.waitForTimeout(4000);
  }

  /** All sufficiently large images currently in the DOM. */
  protected async collectImages(page: Page): Promise<PageImage[]> {
    const all = await page.evaluate((minDim: number) => {
      return Array.from(document.querySelectorAll("img"))
        .map((el) => ({
          src: el.currentSrc || el.src || "",
          width: el.naturalWidth,
          height: el.naturalHeight,
          alt: el.alt ?? "",
        }))
        .filter((i) => i.src && i.width >= minDim && i.height >= minDim);
    }, MIN_IMAGE_DIMENSION);
    return all.filter((i) => this.looksGenerated(i));
  }

  protected looksGenerated(img: PageImage): boolean {
    return this.imageSrcMarkers.some((m) => img.src.includes(m));
  }

  /**
   * Wait until at least one new generated image appears AND the page is no
   * longer busy AND the set of new images has been stable for two polls
   * (progressive previews keep swapping src while rendering).
   */
  protected async waitForNewImages(
    page: Page,
    beforeSrcs: Set<string>,
    req: GenerateRequest
  ): Promise<PageImage[]> {
    const deadline = Date.now() + req.timeoutMs;
    let lastSignature = "";
    let stablePolls = 0;
    let sawBusy = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(POLL_MS);

      const busy = await this.detectBusy(page).catch(() => false);
      if (busy) sawBusy = true;

      const fresh = (await this.collectImages(page)).filter((i) => !beforeSrcs.has(i.src));
      const signature = fresh.map((i) => `${i.src}#${i.width}x${i.height}`).sort().join("|");

      if (fresh.length > 0 && !busy) {
        stablePolls = signature === lastSignature ? stablePolls + 1 : 0;
        if (stablePolls >= 1) return fresh;
      } else {
        stablePolls = 0;
      }
      lastSignature = signature;

      // Response finished without any image → likely a refusal or text answer.
      if (fresh.length === 0 && sawBusy && !busy) {
        await page.waitForTimeout(POLL_MS * 2);
        const retry = (await this.collectImages(page)).filter((i) => !beforeSrcs.has(i.src));
        if (retry.length > 0) continue;
        const reply = await this.lastResponseText(page).catch(() => "");
        throw new ProviderError(
          `${this.name} finished responding without producing an image.` +
            (reply ? ` Response text: "${reply.slice(0, 500)}"` : ""),
          "refused"
        );
      }
    }
    throw new ProviderError(
      `Timed out after ${Math.round(req.timeoutMs / 1000)}s waiting for ${this.name} to produce an image.`,
      "timeout"
    );
  }

  /** Best-effort text of the model's latest reply, used in refusal errors. */
  protected async lastResponseText(page: Page): Promise<string> {
    return page.evaluate(() => {
      const main = document.querySelector("main") ?? document.body;
      const text = (main.textContent ?? "").trim();
      return text.slice(-800);
    });
  }

  /**
   * Download the actual image bytes. blob:/authenticated URLs are fetched in
   * page context so cookies and object URLs both work. Screenshot of the
   * element is the last-resort fallback and is labelled as such.
   */
  protected async captureImage(
    page: Page,
    img: PageImage,
    req: GenerateRequest
  ): Promise<CapturedImage> {
    try {
      const result = await page.evaluate(async (src: string) => {
        const res = await fetch(src);
        if (!res.ok) throw new Error(`fetch ${res.status}`);
        const type = res.headers.get("content-type") ?? "image/png";
        const buf = await res.arrayBuffer();
        let binary = "";
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return { base64: btoa(binary), type };
      }, img.src);
      const buffer = Buffer.from(result.base64, "base64");
      if (buffer.length < 1024) throw new Error("suspiciously small download");
      req.log(`Downloaded ${buffer.length} bytes (${result.type}) from ${img.src.slice(0, 80)}…`);
      return {
        buffer,
        contentType: result.type.split(";")[0].trim(),
        sourceUrl: img.src,
        captureMethod: "download",
      };
    } catch (err) {
      req.log(`Direct download failed (${String(err)}), falling back to element screenshot`);
    }

    const locator = page.locator(`img[src="${img.src}"]`).first();
    const buffer = await locator.screenshot({ type: "png", timeout: 15_000 }).catch(() => null);
    if (!buffer || buffer.length < 1024) {
      throw new ProviderError(
        `Failed to capture the generated image from ${this.name} (download and screenshot both failed).`,
        "capture_failed"
      );
    }
    return { buffer, contentType: "image/png", sourceUrl: img.src, captureMethod: "screenshot" };
  }

  /** Fold the aspect-ratio wish into natural language — web UIs expose no direct control. */
  protected aspectClause(aspectRatio?: string): string {
    if (!aspectRatio) return "";
    const named: Record<string, string> = {
      "16:9": "a wide 16:9 landscape",
      "9:16": "a tall 9:16 portrait",
      "1:1": "a square 1:1",
      "4:3": "a 4:3 landscape",
      "3:4": "a 3:4 portrait",
    };
    const desc = named[aspectRatio] ?? `a ${aspectRatio}`;
    return ` Use ${desc} aspect ratio.`;
  }
}
