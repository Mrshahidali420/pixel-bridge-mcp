import { type Page } from "playwright";
import { BaseChatProvider } from "./base.js";
import type { GenerateRequest, ProviderName } from "./types.js";

/**
 * ChatGPT web adapter (chatgpt.com). Uses the user's own logged-in session
 * from the persistent profile; image generation is requested in plain
 * language, which routes to ChatGPT's built-in image model.
 */
export class ChatGptProvider extends BaseChatProvider {
  readonly name: ProviderName = "chatgpt";
  protected readonly newChatUrl = "https://chatgpt.com/";

  protected readonly composerSelectors = [
    "#prompt-textarea",
    'div[contenteditable="true"][data-virtualkeyboard]',
    'form div[contenteditable="true"]',
    'textarea[data-testid="prompt-textarea"]',
  ];

  protected readonly sendSelectors = [
    '[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'form button[type="submit"]',
  ];

  // Generated images are served from OpenAI's file/asset hosts, or exist as
  // in-page blobs while rendering.
  protected readonly imageSrcMarkers = [
    "oaiusercontent.com",
    "files.openai.com",
    "openai.com/attachments",
    "blob:",
  ];

  protected async detectAuthenticated(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("auth.openai.com") || url.includes("/auth/")) return false;
    const loginButton = page
      .locator('[data-testid="login-button"], a[href*="/auth/login"]')
      .first();
    if (await loginButton.isVisible().catch(() => false)) return false;
    // The composer only renders for a usable session.
    return (await this.findFirst(page, this.composerSelectors)) !== null;
  }

  protected async detectBusy(page: Page): Promise<boolean> {
    const stop = page
      .locator('[data-testid="stop-button"], button[aria-label*="Stop" i]')
      .first();
    return stop.isVisible().catch(() => false);
  }

  protected buildPrompt(req: GenerateRequest): string {
    const base = req.inputImagePath
      ? `Edit the attached image: ${req.prompt}`
      : `Create an image: ${req.prompt}`;
    return (
      base +
      this.aspectClause(req.aspectRatio) +
      " Generate the image directly without asking clarifying questions."
    );
  }
}
