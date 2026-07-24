# Pixel Bridge MCP

[![CI](https://github.com/Mrshahidali420/pixel-bridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrshahidali420/pixel-bridge-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)

**Free AI image generation for Claude Code — through the ChatGPT and Gemini web accounts you already have.** A local [MCP](https://modelcontextprotocol.io) server that drives a real browser (Playwright) against provider web UIs, so you get `generate_image` / `edit_image` tools **without any image-generation API keys**. You log in manually once; Claude Code reviews the results with its own vision.

*Bridges Claude Code → your browser → ChatGPT / Gemini image generation. Hence the name.*

## How it works

```
Claude Code ──MCP──> Pixel Bridge ──Playwright──> your logged-in browser profile
                                                    ├─ chatgpt.com
                                                    └─ gemini.google.com
                     image saved to ./assets/…  <── actual generated file downloaded
Claude Code reads the file with its own vision and judges quality itself.
```

Key principles:

- **You authenticate manually, once.** Each provider gets a persistent Chromium profile (`~/.pixel-bridge/profiles/<provider>`). Log in yourself — including any CAPTCHA or MFA. The server **never** touches credentials and never attempts to bypass security challenges.
- **The MCP is not the art critic.** It returns file paths + metadata; the calling Claude Code model inspects the image visually and decides whether to keep it or regenerate with a better prompt.
- **Never silently "succeeds".** If the real image bytes couldn't be retrieved, the job fails with a reason (refusal text, timeout, UI change, capture failure) and a debug screenshot is saved to `~/.pixel-bridge/logs/`.

## Setup (on your machine)

### Option A — Managed browser (default)

```bash
git clone https://github.com/Mrshahidali420/pixel-bridge-mcp
cd pixel-bridge-mcp
npm install
npx playwright install chromium   # once
npm run build

# One-time manual login per provider (opens a visible browser window):
npm run login -- chatgpt
npm run login -- gemini
```

Tip: set `PIXEL_BRIDGE_BROWSER_CHANNEL=chrome` to use your installed Google Chrome instead of the bundled Chromium.

### Option B — Attach to your own browser (use your existing logins)

Instead of letting Pixel Bridge launch its own browser, you can attach it to a real Chrome/Edge/Brave **you** started, and it will use whatever logins that browser already has. Start your browser with a debugging port and a dedicated profile folder:

```bash
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\pixel-bridge-chrome"

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/pixel-bridge-chrome"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/pixel-bridge-chrome"
```

Log into chatgpt.com / gemini.google.com in that window (once — the profile persists), then run the MCP with:

```
PIXEL_BRIDGE_CDP_URL=http://127.0.0.1:9222
```

Pixel Bridge opens **its own tabs** in that browser, never touches your tabs, and on shutdown closes only its tabs and disconnects — your browser keeps running. You can watch every generation live and handle any login challenge in the same window.

> **Why not my normal day-to-day Chrome profile?** Chrome itself refuses remote debugging on the default profile (a security measure since Chrome 136 that protects your cookies from debugger-based theft), and a running Chrome locks its profile. That's why attach mode needs a dedicated `--user-data-dir` — you still sign in only once there, and it stays signed in like your normal browser. Pixel Bridge does not attempt to bypass this protection.

Register with Claude Code — add to your project's `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "pixel-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/pixel-bridge-mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `generate_image` | Generate via `chatgpt` or `gemini`; saves locally; returns paths + metadata. |
| `edit_image` | Upload a local image + edit instructions; saves the edited result. |
| `generate_with_both` | Same prompt through **both** providers in parallel → two files to compare. |
| `get_generation_status` | Poll a slow job by `job_id` (optionally block up to `wait_seconds`). |
| `download_generated_image` | Copy a completed job's image(s) to an additional location. |
| `check_provider_session` | Is the persistent session logged in and usable? |
| `provider_login` | Open the provider site (headed) and wait while **you** log in manually. |

### Job model (a deliberate design change from the original spec)

Web generation can take minutes, which can exceed MCP client timeouts. So every generation runs as a **background job that saves its own output**:

1. `generate_image` waits inline (default 150 s). Usually the site finishes in time and you get the saved file paths directly.
2. If not, you get a `job_id` with status `running` — poll `get_generation_status`.
3. The job writes the image to the originally requested `output_path` **when it finishes, even if no one is polling** — a client timeout never loses a finished image. `download_generated_image` is therefore only for extra copies.

### File handling

- `output_path` may be a file (`./assets/hero.png`) or a directory (filename auto-derived, or pass `filename`).
- Directories are created automatically. PNG / JPEG / WebP supported — the extension follows the actual content type delivered by the provider.
- Existing files are **never overwritten** unless `overwrite: true`; a `-1`, `-2`… suffix is used instead.
- Results include both absolute and project-relative paths, byte size, content type, and `capture_method`:
  - `"download"` — the real generated file was fetched (full quality).
  - `"screenshot"` — last-resort element screenshot fallback (reported honestly so Claude can decide to retry).

### Aspect ratio

Web UIs expose no reliable aspect-ratio control, so `aspect_ratio` (e.g. `"16:9"`) is folded into the prompt as natural language. **Verify the result visually** — the tool output reminds the calling model to check this.

## Intended Claude Code workflow

1. Ask `generate_image` (or `generate_with_both`) with a concrete prompt, e.g. a 16:9 hero image spec.
2. Read the returned file with vision.
3. Judge: prompt match, composition, artifacts, hands/faces, unwanted text/watermarks, aspect ratio.
4. Keep it, or refine the prompt and regenerate. The MCP never scores quality itself.

## Architecture

```
src/
├── index.ts              MCP server + tool definitions (stdio transport)
├── cli-login.ts          `npm run login -- <provider>` first-run helper
├── config.ts             env-driven config (no credentials, no hardcoded paths)
├── logger.ts             stderr + rolling file logs (stdout is MCP protocol)
├── files.ts              path resolution, mkdir, collision-free naming
├── jobs.ts               background job manager (client timeouts can't lose images)
├── browser.ts            persistent Chromium profile per provider + per-provider queue
└── providers/
    ├── types.ts          ImageProvider interface
    ├── base.ts           shared choreography: selector fallbacks, new-image detection,
    │                     busy/refusal detection, download-with-screenshot-fallback
    ├── chatgpt.ts        ChatGPT web adapter (~60 lines of provider-specific config)
    ├── gemini.ts         Gemini web adapter (~70 lines)
    └── registry.ts       add future providers here
```

Reliability decisions:

- **No brittle DOM assumptions**: each provider supplies *candidate* selector lists tried in order; results are detected generically as "a new ≥300 px image appeared and stayed stable after the model stopped responding", not via provider DOM structure.
- **Refusal detection**: if the model finishes replying with no image, the reply text is returned in the error so Claude can rephrase.
- **Per-provider serialization**: concurrent calls to one provider queue up; different providers run in parallel (that's how `generate_with_both` works).
- **Debuggability**: every failure saves a page screenshot to `~/.pixel-bridge/logs/`, and job results include recent step-by-step logs.

## Configuration (env vars, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PIXEL_BRIDGE_HOME` | `~/.pixel-bridge` | Profiles + logs root |
| `PIXEL_BRIDGE_PROFILE_DIR` | `<home>/profiles` | Browser profiles location |
| `PIXEL_BRIDGE_HEADLESS` | `false` | Headed is the default — friendlier to consumer sites and required for manual login |
| `PIXEL_BRIDGE_BROWSER_CHANNEL` | – | e.g. `chrome` to use your installed Chrome instead of bundled Chromium |
| `PIXEL_BRIDGE_EXECUTABLE_PATH` | – | Explicit browser binary path |
| `PIXEL_BRIDGE_CDP_URL` | – | Attach mode: connect to your own running browser (e.g. `http://127.0.0.1:9222`) instead of launching one |
| `PIXEL_BRIDGE_GENERATION_TIMEOUT_S` | `300` | Hard ceiling per generation |
| `PIXEL_BRIDGE_DEFAULT_WAIT_S` | `150` | Default inline wait before returning a job id |
| `PIXEL_BRIDGE_LOGIN_TIMEOUT_S` | `300` | Manual-login wait |
| `HTTPS_PROXY` | – | Forwarded to the browser when set (corporate proxies) |

## Security posture

- No credentials in code, config, or logs; nothing to hardcode.
- Sessions live only in the local browser profile — `.gitignore` excludes profiles; never commit them (they contain live cookies).
- CAPTCHAs, MFA, and bot checks are **never** automated. When a provider challenges, the tools report it and `provider_login` hands control to you in a visible window.
- Respect each provider's terms of service; this drives your own account through its normal web UI at human-triggered, low volume.

## Status / what's been verified

Built and smoke-tested in a headless cloud environment:

- ✅ Compiles clean; server starts and serves all 7 tools over MCP stdio.
- ✅ File naming/collision/extension logic verified with unit checks.
- ✅ Job lifecycle, error propagation, and failure screenshots verified.
- ⏳ The live browser flows (login → generate → download) need a run on a real desktop — the cloud sandbox has no display, blocks chatgpt.com entirely, and its TLS-intercepting proxy interferes with Playwright-driven navigation. First local test: `npm run login -- gemini`, then ask Claude Code to generate a test image into `./assets/`.

## Adding a provider later

Implement `BaseChatProvider` (URLs, selector candidates, logged-in/busy detection, prompt phrasing — see `chatgpt.ts` for how small that is) and register it in `providers/registry.ts`. Non-chat UIs can implement the `ImageProvider` interface directly.

## Contributing

Contributions are very welcome — especially **selector fixes when provider UIs change** and **new provider adapters** (Bing Image Creator, Ideogram, Playground, …). See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the adapter guide, and the hard rules (no credential handling, no CAPTCHA/MFA/bot-detection bypassing, no silent success). If this project is useful to you, a ⭐ helps others find it.

## License

[MIT](LICENSE) © Shahid Ali

## Disclaimer

Pixel Bridge automates *your own* account through its normal web interface at human scale. Respect each provider's terms of service and rate limits; you are responsible for how you use it. This project is not affiliated with OpenAI, Google, or Anthropic.
