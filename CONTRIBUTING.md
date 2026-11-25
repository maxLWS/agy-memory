# Contributing to `agy-memory`

Thanks for your interest in contributing to `agy-memory`!

## Development Setup

Requirements: **Node.js >= 20** (runtime bundles have zero external dependencies; `typescript`, `esbuild`, and `@types/node` are dev-only).

```bash
git clone https://github.com/maxLWS/agy-memory.git
cd agy-memory
npm install
```

## Workflow

1. Make changes under `src/` (strict TypeScript) or `test/`.
2. Rebuild the committed zero-dependency runtime bundles in `dist/`:
   ```bash
   npm run typecheck
   npm run build
   npm test
   npm run bench:stress
   ```
3. If you modified `plugin.json`, `mcp_config.json`, `hooks.json`, or `rules/AGENTS.md`, run:
   ```bash
   npm run validate
   ```
4. Ensure `dist/mcp-server.mjs` and `dist/session-start.mjs` are up to date before opening a PR (CI verifies `git diff --exit-code -- dist/`).

## Design Guardrails

- **Zero runtime dependencies**: Do not add runtime packages to `dependencies` in `package.json`.
- **100% local & read-only**: Never make network calls from the MCP server or hook, and never open Antigravity's `conversation_summaries.db` in read-write mode.
- **Strict inline budget**: Keep every MCP tool output within the 8650-byte UTF-8 inline cap so Antigravity never spills tool results to disk.
- **Cross-platform**: Keep code and tests compatible with Linux, macOS, and Windows (including environments without `sqlite3`, `python3`, or `rg`).
