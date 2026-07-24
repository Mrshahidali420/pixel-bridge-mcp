import { type Page } from "playwright";
import { BaseChatProvider } from "./base.js";
import type { GenerateRequest, ProviderName } from "./types.js";

/**
 * Google Gemini web adapter (gemini.google.com). Relies on the user's own
 * Google session in the persistent profile.
 */
export class GeminiProvider extends BaseChatProvider {
  readonly name: ProviderName = "gemini";
  protected readonly newChatUrl = "https://gemini.google.com/app";

  protected readonly composerSelectors = [
    'rich-textarea div[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
  ];

  protected readonly sendSelectors = [
    'button[aria-label*="Send" i]',
    'button[mattooltip*="Send" i]',
    ".send-button",
  ];

  // Generated images are served from Google's user-content hosts or as blobs.
  protected readonly imageSrcMarkers = [
    "googleusercontent.com",
    "gstatic.com/gemini",
    "blob:",
  ];

  protected async detectAuthenticated(page: Page): Promise<boolean> {
    const url = page.url();
    if (url.includes("accounts.google.com")) return false;
    const signIn = page
      .locator('a[href*="accounts.google.com"], a:has-text("Sign in")')
      .first();
    if (await signIn.isVisible().catch(() => false)) return false;
    return (await this.findFirst(page, this.composerSelectors)) !== null;
  }

  protected async detectBusy(page: Page): Promise<boolean> {
    const stop = page
      .locator('button[aria-label*="Stop" i], .stop-icon, mat-spinner, .loading-indicator')
      .first();
    return stop.isVisible().catch(() => false);
  }

  protected buildPrompt(req: GenerateRequest): string {
    const base = req.inputImagePath
      ? `Edit the attached image: ${req.prompt}`
      : `Generate an image: ${req.prompt}`;
    return (
      base +
      this.aspectClause(req.aspectRatio) +
      " Generate the image directly without asking clarifying questions."
    );
  }

  /**
   * Google avatars also come from googleusercontent.com; the base class's
   * minimum-dimension filter removes them (avatars are small), but be extra
   * safe and drop obvious profile photos.
   */
  protected override looksGenerated(img: { src: string; width: number; height: number; alt: string }): boolean {
    if (!super.looksGenerated(img)) return false;
    if (/profile|avatar/i.test(img.alt)) return false;
    // Real generations are large; avatar CDN URLs typically carry =s## size hints.
    if (/=s\d{1,3}(-|$)/.test(img.src) && img.width < 400) return false;
    return true;
  }
}
