# Security Policy

Pixel Bridge drives your own logged-in browser sessions, so treat it with the same care as your browser profile:

- Browser profiles under `~/.pixel-bridge/profiles/` (and any attach-mode `--user-data-dir`) contain **live session cookies**. Never commit, share, or upload them. They are `.gitignore`d.
- The server never reads, stores, or transmits credentials, and never bypasses CAPTCHA/MFA/bot protections — by design. PRs adding such behavior are rejected (see CONTRIBUTING.md).
- The MCP server listens on stdio only; it opens no network ports (attach mode *connects out* to a debugging port you opened yourself — keep that port bound to 127.0.0.1).

## Reporting a vulnerability

Please open a private security advisory on GitHub ("Security" tab → "Report a vulnerability") rather than a public issue, or email the maintainer. Include reproduction steps; you'll get a response as soon as possible.
