import { ChatGptProvider } from "./chatgpt.js";
import { GeminiProvider } from "./gemini.js";
import type { ImageProvider, ProviderName } from "./types.js";

/**
 * Adding a provider later = implement BaseChatProvider (or ImageProvider
 * directly for non-chat UIs) and register it here.
 */
const providers = new Map<ProviderName, ImageProvider>();

function register(p: ImageProvider): void {
  providers.set(p.name, p);
}

register(new ChatGptProvider());
register(new GeminiProvider());

export function getProvider(name: string): ImageProvider {
  const p = providers.get(name as ProviderName);
  if (!p) {
    throw new Error(
      `Unknown provider "${name}". Available: ${[...providers.keys()].join(", ")}`
    );
  }
  return p;
}

export function providerNames(): ProviderName[] {
  return [...providers.keys()];
}
