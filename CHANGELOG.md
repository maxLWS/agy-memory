# Changelog

All notable changes to `agy-memory` are documented in this file.

## [0.2.0] - 2026-11-25

### Added
- **TypeScript + zero-dependency single-file packaging**: Migrated all source modules to strict TypeScript (`src/*.ts`) compiled with `esbuild` into unminified, zero-dependency single-file bundles (`dist/mcp-server.mjs`, `dist/session-start.mjs`).
- **Cross-platform support (Linux, macOS, Windows)**:
  - Native Node 22.5+/24 `node:sqlite` read-only backend (zero subprocess spawn), with automatic fallback to `sqlite3` CLI, cross-platform Python (`pathlib.Path.as_uri()` + `?mode=ro`), and pure-JS `brain/` directory scanning.
  - Windows `file:///C:/...` workspace URI normalization, backslash path matching, and Windows `rg` path lookup.
  - One-command installers (`install.sh` and `install.ps1`), self-contained `scripts/install.mjs` (`install`, `update`, `uninstall`, `status`, `doctor`, `--project`), and synthetic CI stress suite (`npm run bench:stress`).
- **Search & recall upgrades**:
  - `sessionId` single-conversation scoping and prefix/multi-ID `excludeSessionId` on `search_sessions` and `list_sessions`.
  - Automatic `transcript_full.jsonl` hydration for `truncated_fields` in both search and `read_session(mode="turns")`, plus `charOffset` pagination for >8.2 KB turns.
  - Automatic exclusion of active in-flight `USER_INPUT` prompts (eliminating self-matching on negative queries) and authoritative 0-match coverage reporting.
  - Greedy term-coverage & step/source diversity snippet selection, recency-decayed ranking, and strict `scope` isolation.
  - Artifact hits expose full `Path` and line count for direct native `read_file` handoff.
- **Swarm & digest upgrades**:
  - Newest-preserving budget packing in `read_session(mode="swarm")`, board-derived agent roster fallback when `members.json` is absent, and `startSeq` / `endSeq` / `query` filters (`tailMessages` up to 100).
  - Tool-only turn summaries and high-signal middle milestone sampling in `read_session(mode="digest")`.
- **Diagnostics & offline analytics**:
  - Added `--cli stats` offline transcript usage analyzer (`src/analytics.ts`) and `install.mjs doctor`.

### Fixed
- Fixed `SessionStart` snapshot surfacing noisy tiny/temp probes and failing to extract substantive prompts from >160 KB tool tails; now injects `Current session: <shortId>` and pinned note `[tags]`.
- Fixed UTF-16 surrogate-pair splitting, ASCII byte overrun near 8650 B, and negative `maxChars` clamping in `truncateUtf8`.
- Fixed LSP stdio framing when `Content-Type` precedes `Content-Length`, added proper JSON-RPC `-32700` / `-32600` error responses, MCP `isError: true` on validation failures, and clean stdout flushing on EOF.

## [0.1.0] - 2026-11-24

### Added
- Initial Antigravity native plugin release with 5 eager MCP tools (`list_sessions`, `search_sessions`, `read_session`, `save_note`, `recall_notes`), `SessionStart` snapshot hook, `rules/AGENTS.md`, and `--cli` fallback mode.
