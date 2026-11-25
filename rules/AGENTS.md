# agy-memory Cross-Conversation Memory Rules

Use `agy-memory_memory` MCP tools whenever the user references a previous conversation, past file edits or command failures, another CLI session (Codex / Claude Code), or cross-session notes.

1. **Direct invocation & `toolSummary`**: Call `mcp_agy-memory_memory_*` directly with `toolSummary`. Do **not** shell out to `grep`/`python3` over `~/.gemini/antigravity-cli/`, `~/.codex/`, or `~/.claude/` when `agy-memory` can answer it.
2. **Use `SessionStart` first**: Check `[agy-memory]` at startup (`Current session`, recent sessions, pinned notes) and skip redundant `list_sessions` / `recall_notes` calls when it already answers the question.
3. **Qualified exclusion & scan coverage**: Pass `excludeSessionId="agy:<id>"` from `SessionStart` when searching past sessions. Trust 0-match negative results **only when scan coverage is complete**—never treat an `INCOMPLETE SCAN` as proof of absence (narrow with `workspace`/`sinceDays`).
4. **Mode routing & verbatim verification**:
   - `mode="text"` searches user/assistant replies (hydrated from `transcript_full.jsonl`), Markdown artifacts, and Swarm boards (across `agy`, `codex`, `claude`).
   - `mode="file_history"` (`agy`) traces verified file writes vs reads from `transcript.jsonl`; `mode="error_history"` (`agy`) traces failed commands, test failures, and non-zero exit codes. **Use `mode="error_history"` for failed commands/tests even when querying a filename.** Never claim a candidate edit fixed an error without verifying the cited `#step` turns.
   - When `search_sessions`, `read_session(mode="artifacts")`, or `recall_notes` returns a `.md` `Path` >100 lines, read it directly with built-in `read_file(Path)`.
5. **Cross-CLI scope (`source`)**: Default `source` is `"agy"`. Pass `source: "all"` (or `"codex"` / `"claude"`) when the user mentions Codex or Claude Code, and use qualified IDs (`codex:<id>`, `claude:<id>`) for single-session reads/searches.
6. **Swarm, large turns, CAS notes & `--cli`**: Use `read_session(mode="swarm")` for Swarm boards, `charOffset` for >8.2 KB turns, and `expectedRevision` from `save_note`/`recall_notes` for safe note updates. Swarm workers without MCP can run `node "<plugin>/dist/mcp-server.mjs" --cli list|search|read ...`.
