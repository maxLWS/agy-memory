# Changelog

All notable changes to `agy-memory` are listed here.

## [0.4.1] - 2026-11-26

### Fixed
- **Unclipped Swarm message inspection (`read_session(mode="swarm")`)**: removed the hardcoded 1,400-char per-message cap on small slices in `src/store.ts`. Single-message reads (`startSeq=N, endSeq=N`) now use the full inline budget (~7,500 chars, staying `<= 8,650` UTF-8 bytes with zero disk spills), 2–4 message slices scale dynamically across the budget, and clipped summaries now print the exact `startSeq=N endSeq=N` hint (or full `board.jsonl` path for extreme single messages).
- **Verified impact on real Swarm audit recall (`F1`)**: dropped from 126.5s timeout / 23 turns / 196.5k billable / 4 spills (`v0.4.0`) to 50.4s / 5 turns / 63.9k billable / 0 raw shell history reads / 0 spills (`v0.4.1`).

## [0.4.0] - 2026-11-26

### Added
- **Project Blackboard (`board_read`, `board_post`)**:
  - Stores active project conventions, accepted decisions, and open handoffs as one Markdown file per key under `~/.gemini/agy-memory/boards/<scope>/entries/<slug>.md`, with human-editable frontmatter (`schema: 1`, `key`, `title`, `updatedAt`, `sourceClient`, `sourceSession`, optional `sourceStep`).
  - Uses per-key atomic `linkSync` locking plus a serialized dead-PID reaper (zero global lock; distinct keys write lock-free; live writers are never preempted) and mandatory `expectedRevision` compare-and-swap on updates and deletes.
  - Includes idempotent, non-destructive migration (`--cli migrate-notes`) from legacy `topics/*.md` / `notes.json`.
- **Disjoint `ScopeKey` aggregation & Turn-0 `project_id` resolution (`src/scope.ts`)**:
  - Separates named Antigravity Projects (`project/<projectId>`) from plain CLI repositories (`cli_repo/<gitCommonDir>`, unifying linked Git worktrees with zero subprocesses), plain non-Git workspaces (`cli_workspace/<root>`), `global`, and fail-closed `unresolved`.
  - Reads top-level Protobuf field 18 (`project_id`) and field 7 (workspace URI) directly from WAL-safe `conversations/<id>.db` so brand-new `agy --project <id>` sessions receive their exact Project Blackboard on Turn 0 before `conversation_summaries.db` is populated.
  - Merges catalogs across Antigravity App (`~/.gemini/antigravity`), CLI (`~/.gemini/antigravity-cli`), and IDE (`~/.gemini/antigravity-ide`) by `conversation_id`, failing closed to `unresolved` on conflicting `project_id` and preserving transcript-bearing copies.
- **Read-only whole-unit `SessionStart` snapshot (`src/snapshot.ts`)**:
  - Inlines whole board entries when total rendered bytes `<= 1,536` UTF-8 bytes; degrades cleanly to a whole-key index above `1,536` bytes without mid-entry truncation.
  - Adds a 1-line sibling activity hint (`AGY_MEMORY_SIBLING_HINT=0` to disable) and removes the legacy "last 5 titles + 88-char prompt slice" heuristic.

### Changed
- **Focused 4-tool MCP surface (4 tools / 43 params, down from 5 tools / 52 params)**:
  - Merged `list_sessions` into `search_sessions` (omit `query` in `text` mode to list recent sessions).
  - Enforced strict scope boundaries on `search_sessions` (requires `conversationId`, `scopeKey`, `sessionId`, `workspace`, or explicit `allScopes=true`) so sibling Projects sharing one folder never bleed into each other.
  - Trimmed tool descriptions and `rules/AGENTS.md` (1,361 B), cutting Turn-1 metadata from `7,674 B` (`v0.3.0`) and `13,946 B` (post-v0.3.0 schema expansion) to `7,092 B` (`-656` Turn-1 input tokens vs. `v0.3.0`, `-1,753` vs. expanded schemas).
  - Hardened `--cli` boolean flag parsing (`--delete=false`, `--all-scopes`, etc.) so boolean switches never swallow positional queries and reject invalid boolean strings.

### Removed
- **Removed Codex (`~/.codex`) and Claude Code (`~/.claude`) cross-CLI adapters** (`src/adapters.ts`, ~500 LOC) to keep `agy-memory` focused on Google Antigravity (`App`, `CLI`, and `IDE`).
- **Replaced legacy `save_note` / `recall_notes` (`src/notes.ts`, global `.notes.lock`, `MEMORY.md` index)** with the per-key Project Blackboard.
- **Moved offline usage stats (`analytics.ts`) out of the runtime MCP bundle** into `scripts/analytics.ts`.

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
