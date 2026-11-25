# agy-memory Cross-Conversation Memory Rules

Use `agy-memory_memory` MCP tools whenever the user references a previous conversation, another open session, past decisions/artifacts/Swarms, or asks to remember/recall something across sessions.

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| See recent sessions (titles, IDs, workspace, step count, substantive prompt, badges) | `list_sessions` (pass `minSteps: 5` to skip tiny probes) | Cached SQLite catalog query (<2ms warm) without reading raw JSONL |
| Find which past conversation (or step inside one session) discussed a topic | `search_sessions` (supports `sessionId` & `excludeSessionId` prefixes) | Searches transcripts (with full-reply hydration), Markdown artifacts, and Swarm boards in one call |
| Inspect a specific past conversation, artifact, or Swarm board | `read_session` (`mode: "digest" \| "turns" \| "artifacts" \| "swarm"`) | Clean structured view; `swarm` preserves newest messages & supports `query`/`startSeq`/`endSeq` |
| Save / recall curated cross-session notes | `save_note` / `recall_notes` | Atomic persistent notes outside `AGENTS.md`, searchable by ID, topic, content, tag, or workspace |

## Rules

1. **Direct invocation (eager-first) & `toolSummary`**: Call `mcp_agy-memory_memory_*` directly and always include `toolSummary` under Antigravity eager loading. Do **not** shell out to `grep`/`python3` over `~/.gemini/antigravity-cli/brain/*/transcript.jsonl` when `agy-memory` can answer it cleanly.
2. **Use the `SessionStart` snapshot first**: Check the injected `[agy-memory]` block at session start—it already shows `Current session: <shortId>`, recent substantive workspace sessions, and pinned notes (including `[tags]`). Do not make redundant `list_sessions` or `recall_notes` calls if the snapshot already answers the question.
3. **Exclude current session & trust 0-match negative results**: Pass `excludeSessionId` (the 8-char ID from `SessionStart`) when searching past sessions. When `search_sessions` + `recall_notes` report 0 past matches (covering transcripts, artifacts, Swarm boards, and notes), trust that result and report "not found" directly instead of running slow recursive `grep` across `~/.gemini/antigravity-cli/` or the workspace.
4. **Search inside a session & read large `.md` artifacts directly**: Pass `sessionId` to `search_sessions` to jump straight to relevant steps inside a long conversation. When `search_sessions` or `read_session(mode="artifacts")` gives the `Path` of a Markdown artifact >100 lines, call built-in `read_file(Path)` directly (46 KB inline, ~7ms) instead of paginating 8.6 KB MCP chunks.
5. **Swarm boards & large turns**: For Swarm sessions, call `read_session({ sessionId, mode: "swarm", tailMessages, startSeq, endSeq, query })` (newest messages are preserved automatically). For >8.2 KB turns, pass the returned `charOffset` to continue cleanly.
6. **High-signal notes & Swarm workers (`--cli`)**: Save only reusable cross-session facts/preferences via `save_note` (never secrets/tokens). Swarm workers without MCP can run `node "<plugin>/dist/mcp-server.mjs" --cli search|read|list ...`.

## Quick Schemas (`ServerName: "agy-memory_memory"`)

> Under Antigravity eager loading, include `toolSummary` alongside these parameters.

- **`list_sessions`**: `{ workspace?, query?, includeChildren?, excludeSessionId?, sinceHours?, minSteps?, limit?: 1..50, maxChars?: 200..8200 }`
- **`search_sessions`**: `{ query, scope?: "all"|"user"|"assistant"|"artifacts"|"swarm", regex?, sessionId?, workspace?, includeChildren?, excludeSessionId?, sinceDays?, maxSessions?: 1..25, maxSnippetsPerSession?: 1..8, maxChars?: 200..8200 }`
- **`read_session`**: `{ sessionId, mode?: "digest"|"turns"|"artifacts"|"swarm", startStep?, endStep?, tailTurns?: 1..40, charOffset?, includeTools?, includeThinking?, artifactName?, startLine?, endLine?, tailMessages?: 1..100, startSeq?, endSeq?, query?, maxChars?: 200..8200 }`
- **`save_note`**: `{ topic?, content?, workspace?, tags?: string[], sessionId?, id?, deleteId? }`
- **`recall_notes`**: `{ query?, workspace?, tag?, limit?: 1..30, maxChars?: 200..8200 }`
