# Changelog

All notable changes to `agy-memory` are listed here.

## [0.3.0] - 2026-11-25

### Added
- **File & error history in `search_sessions`** (still 5 MCP tools, zero runtime dependencies):
  - `mode="file_history"` (`agy`): checks which past sessions actually edited vs. only read a file, separates verified writes (`write_succeeded`) from failed or unconfirmed ones (`write_failed`, `write_unverified`), and disambiguates duplicate filenames across directories.
  - `mode="error_history"` (`agy`): finds past command/tool failures with exit codes, lists later edits in the same session, and checks whether the exact same command + working directory later passed (`PASSED` vs. `UNRESOLVED`).
  - Streaming JSONL reader with incremental byte offsets, 32 MB / 2.5 s scan caps, partial-progress resumption, and explicit `INCOMPLETE SCAN` notices when a cap is hit.
- **Editable Markdown notes (`topics/<id>.md` + `MEMORY.md`)**:
  - Stores each note as a plain Markdown file with `schema: 1` frontmatter and updates a managed index block in `MEMORY.md` while keeping any manual text outside the markers.
  - Returns a `Revision` hash from `save_note` and `recall_notes`; passing `expectedRevision` rejects stale updates or deletes instead of overwriting the file on disk.
  - Serializes concurrent writes with a lockfile, preserves existing `workspace`/`tags` on ID-only updates, and migrates legacy `notes.json` on first note tool call (leaving `SessionStart` strictly read-only).
- **Read-only Codex & Claude Code support**:
  - `list_sessions`, `search_sessions(mode="text")`, and `read_session` accept `source="codex"|"claude"|"all"` while keeping `source="agy"` as the default.
  - Sessions are addressed with source-qualified IDs (`codex:<id>`, `claude:<id>`, `agy:<id>`) to avoid prefix collisions.

### Fixed & Improved
- Cut total startup prompt size (`5 tool schemas + rules/AGENTS.md`) by **30.4%** vs. `v0.2.0` (`11,022 B → 7,668 B`, saving ~630 Turn-1 input tokens) by removing duplicated schema blocks from `rules/AGENTS.md`.
- Bypassed raw-file `rg` prefiltering for `regex: true` searches to prevent false negatives on JSON-escaped lines, kept artifact-filename-only hits in literal prefiltering, enforced single-session ambiguity checks in `search_sessions(sessionId=...)`, and marked read I/O errors as incomplete scans.

## [0.2.0] - 2026-11-25

### Added
- TypeScript rewrite (`src/*.ts`) compiled with `esbuild` into single-file, zero-dependency ESM bundles (`dist/mcp-server.mjs`, `dist/session-start.mjs`).
- Cross-platform SQLite catalog loading (Node 22.5+ `node:sqlite`, `sqlite3`, Python `sqlite3`, pure-JS fallback), Windows path normalization, one-line installers (`install.sh` / `install.ps1`), and `scripts/install.mjs` (`install`, `update`, `uninstall`, `status`, `doctor`, `--project`).
- Single-session `sessionId` scoping, prefix/multi-ID `excludeSessionId`, automatic `transcript_full.jsonl` hydration for truncated turns, `charOffset` pagination for >8.2 KB turns, newest-preserving Swarm packing (`startSeq` / `endSeq` / `query`), and `--cli stats`.

### Fixed
- Skipped active in-flight `USER_INPUT` prompts during search to prevent current-session self-matches on negative queries.
- Fixed UTF-16 surrogate splitting and byte-cap edge cases in `truncateUtf8`, plus LSP framing when `Content-Type` precedes `Content-Length`.

## [0.1.0] - 2026-11-24

### Added
- Initial plugin release with 5 MCP tools (`list_sessions`, `search_sessions`, `read_session`, `save_note`, `recall_notes`), `SessionStart` snapshot hook, `rules/AGENTS.md`, and `--cli` mode.
