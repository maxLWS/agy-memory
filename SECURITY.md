# Security & Privacy Policy

## Supported Versions

Security fixes are applied to the latest release and the `main` branch:

| Version | Supported |
| :--- | :---: |
| `main` / `0.2.x` | :white_check_mark: |
| `< 0.2.0` | :x: |

## Privacy & Security Model

Because `agy-memory` indexes local Antigravity conversation histories, it is designed to be auditable, minimally privileged, and 100% local:

- **Zero runtime dependencies** — pre-built, unminified single-file ESM bundles in `dist/mcp-server.mjs` and `dist/session-start.mjs` can be inspected directly without installing `node_modules`.
- **Zero network access** — `agy-memory` makes **no outbound HTTP/network requests** of any kind. All indexing, search, digest generation, and note storage happen locally over MCP Stdio.
- **Strictly read-only on Antigravity state** — `conversation_summaries.db` is always opened in read-only mode (`node:sqlite` `{ readOnly: true }`, `sqlite3 -readonly`, or Python `file:...?mode=ro`), and `brain/*` transcripts, artifacts, and Swarm boards are never mutated.
- **Isolated note storage** — curated notes created via `save_note` are written atomically to `<appDataDir>/plugin_data/agy-memory/notes.json` (mode `0600` on POSIX) outside Antigravity's internal databases. Never store API keys, tokens, or credentials in notes.
- **Policy-compliant** — does not intercept, bypass, or alter Antigravity's native permissions, checkpoints, or safety boundaries.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for suspected security vulnerabilities.

Report them privately via GitHub Security Advisories:

- https://github.com/maxLWS/agy-memory/security/advisories/new

Include reproduction steps, affected file paths or commit SHA, and potential impact.
