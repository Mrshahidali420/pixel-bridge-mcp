#!/usr/bin/env node
/**
 * Standalone first-run login helper:
 *
 *   npm run login -- chatgpt
 *   npm run login -- gemini
 *
 * Opens a headed browser on the provider's site using the same persistent
 * profile the MCP server uses, and waits for you to log in manually
 * (credentials, CAPTCHA, MFA — all handled by you, never by this tool).
 */
import { browserManager } from "./browser.js";
import { config } from "./config.js";
import { getProvider, providerNames } from "./providers/registry.js";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error(`Usage: npm run login -- <${providerNames().join("|")}>`);
    process.exit(1);
  }
  if (config.headless && !config.cdpUrl) {
    console.error("PIXEL_BRIDGE_HEADLESS is set — unset it so you can see the login window.");
    process.exit(1);
  }
  const provider = getProvider(name);
  console.error(`Opening ${name}. Log in manually in the browser window (up to ${Math.round(config.loginTimeoutMs / 60000)} min)…`);
  const status = await provider.waitForLogin(config.loginTimeoutMs);
  console.error(JSON.stringify(status, null, 2));
  await browserManager.closeAll();
  process.exit(status.authenticated ? 0 : 2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
