# Contributing to Pixel Bridge MCP

Thanks for your interest! PRs and issues are very welcome — this project lives or dies by keeping up with provider web UIs, and that's a community effort.

## Ways to help

- **Fix a broken selector** — providers redesign their UIs; adapter fixes are the most valuable PRs.
- **Add a provider** — see the guide below; an adapter is typically 60–80 lines.
- **Improve detection heuristics** — busy/refusal/new-image detection in `src/providers/base.ts`.
- **Report breakage** — an issue with logs + the failure screenshot from `~/.pixel-bridge/logs/` is hugely useful.

## Dev setup

```bash
git clone https://github.com/Mrshahidali420/pixel-bridge-mcp
cd pixel-bridge-mcp
npm install
npx playwright install chromium
npm run build        # or: npm run dev (tsc --watch)
npm run login -- chatgpt   # one-time manual login per provider
```

Manual end-to-end test (there is no automated test against live providers — don't hammer them):

1. Register the server in a Claude Code project (`.mcp.json`, see README).
2. `check_provider_session` → expect `authenticated: true`.
3. `generate_image` with a simple prompt into a scratch directory.
4. Verify the saved file opens and `capture_method` is `"download"`.

## Adding a provider

1. Create `src/providers/<name>.ts` extending `BaseChatProvider` (see `chatgpt.ts` — it's small). You supply:
   - `newChatUrl` — URL that opens a fresh conversation
   - `composerSelectors` / `sendSelectors` — *candidate lists*, most-specific first
   - `imageSrcMarkers` — src substrings identifying generated images
   - `detectAuthenticated` / `detectBusy`
   - `buildPrompt` — phrasing that reliably triggers image generation
2. Add the name to `ProviderName` in `src/providers/types.ts` and register in `src/providers/registry.ts`.
3. Update the README provider list.

Guidelines: prefer robust signals (roles, aria-labels, URL patterns, "new large image appeared") over deep CSS paths; assume the UI will change and fail with a clear `ProviderError` when it does.

## Hard rules (PRs violating these will be declined)

- **No credential handling.** The user logs in manually, always. No password fields, no token storage, no cookie import/export utilities.
- **No bypassing security controls.** Nothing that automates or evades CAPTCHAs, MFA, bot detection, rate limits, or Chrome's remote-debugging profile protections.
- **No silent success.** If real image bytes weren't retrieved, the job must fail with a reason. Screenshot fallback must stay honestly labelled (`capture_method: "screenshot"`).
- **No quality judging in the server.** The calling model reviews images; the server reports facts.

## PR checklist

- `npm run build` passes with no TypeScript errors.
- Describe which provider(s) you tested against manually and what you observed.
- Keep PRs focused — one fix/feature per PR.
- Match the existing code style (no lint setup yet; follow what's there).

## Reporting bugs

Please include: OS, Node version, provider, the tool call you made, the returned error, relevant lines from `~/.pixel-bridge/logs/pixel-bridge-<date>.log`, and (if UI-related) the failure screenshot from the same directory. **Redact anything personal — never attach your browser profile.**
