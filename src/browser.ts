import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "./config.js";
import { getLogger } from "./logger.js";

const log = getLogger("browser");

/**
 * Two modes:
 *
 * LAUNCH (default): one persistent Chromium profile per provider under
 * ~/.pixel-bridge/profiles/. Cookies/local storage survive restarts, so the
 * user logs in manually once and the session is reused.
 *
 * ATTACH (PIXEL_BRIDGE_CDP_URL set): connect to a browser the USER started
 * with --remote-debugging-port. Their existing logins are used as-is. We only
 * ever operate on tabs we opened ourselves — never the user's tabs — and on
 * shutdown we close our tabs and disconnect, leaving their browser running.
 *
 * No credentials are ever handled by this code in either mode.
 *
 * All work for a given provider is serialized through a per-provider queue so
 * two jobs never fight over the same tab.
 */
class BrowserManager {
  private contexts = new Map<string, BrowserContext>();
  private cdpBrowser: Browser | null = null;
  /** Tabs we created, one per provider. */
  private pages = new Map<string, Page>();
  private queues = new Map<string, Promise<unknown>>();

  private async getCdpContext(): Promise<BrowserContext> {
    if (this.cdpBrowser?.isConnected()) {
      const existing = this.cdpBrowser.contexts()[0];
      if (existing) return existing;
    }
    log.info(`Attaching to running browser at ${config.cdpUrl}`);
    try {
      this.cdpBrowser = await chromium.connectOverCDP(config.cdpUrl!);
    } catch (err) {
      throw new Error(
        `Could not attach to a browser at ${config.cdpUrl}. Start your browser with ` +
          `--remote-debugging-port and a dedicated --user-data-dir first (see README "Attach mode"). ` +
          `Underlying error: ${String(err)}`
      );
    }
    const context = this.cdpBrowser.contexts()[0] ?? (await this.cdpBrowser.newContext());
    context.setDefaultTimeout(20_000);
    return context;
  }

  private async launchContext(provider: string): Promise<BrowserContext> {
    const existing = this.contexts.get(provider);
    if (existing) {
      try {
        existing.pages();
        return existing;
      } catch {
        this.contexts.delete(provider);
      }
    }

    const profileDir = path.join(config.profilesDir, provider);
    fs.mkdirSync(profileDir, { recursive: true });
    log.info(
      `Launching persistent context for ${provider} (profile: ${profileDir}, headless: ${config.headless})`
    );
    // Chromium does not reliably honor proxy env vars on its own; forward
    // them explicitly so corporate/sandbox proxies work.
    const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      channel: config.browserChannel,
      executablePath: config.executablePath,
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
      proxy: proxyServer ? { server: proxyServer } : undefined,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    context.setDefaultTimeout(20_000);
    context.on("close", () => {
      this.contexts.delete(provider);
      log.info(`Context for ${provider} closed`);
    });
    this.contexts.set(provider, context);
    return context;
  }

  async getContext(provider: string): Promise<BrowserContext> {
    return config.cdpUrl ? this.getCdpContext() : this.launchContext(provider);
  }

  /** Get (or create) OUR tab for this provider. Never reuses a user-opened tab. */
  async getPage(provider: string): Promise<Page> {
    const existing = this.pages.get(provider);
    if (existing && !existing.isClosed()) return existing;
    const context = await this.getContext(provider);
    const page = await context.newPage();
    this.pages.set(provider, page);
    return page;
  }

  /**
   * Run `fn` exclusively for this provider — calls queue up behind each other
   * so concurrent tool calls can't interleave keystrokes in one tab.
   * Different providers still run in parallel.
   */
  async withProvider<T>(provider: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const prev = this.queues.get(provider) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined) // one failed job must not poison the queue
      .then(async () => {
        const page = await this.getPage(provider);
        return fn(page);
      });
    this.queues.set(provider, run);
    return run;
  }

  async closeAll(): Promise<void> {
    // Close only tabs we opened.
    for (const [name, page] of this.pages) {
      if (!page.isClosed()) {
        await page.close().catch((err) => log.warn(`Error closing tab ${name}: ${String(err)}`));
      }
    }
    this.pages.clear();
    for (const [name, ctx] of this.contexts) {
      try {
        await ctx.close();
      } catch (err) {
        log.warn(`Error closing context ${name}: ${String(err)}`);
      }
    }
    this.contexts.clear();
    if (this.cdpBrowser) {
      // Disconnects from the user's browser; does not terminate it.
      await this.cdpBrowser.close().catch(() => undefined);
      this.cdpBrowser = null;
    }
  }
}

export const browserManager = new BrowserManager();
