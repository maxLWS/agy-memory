# agy-memory Rules

Use `agy-memory_memory` MCP tools directly (include `toolSummary`). Do not grep or run sqlite3 over `~/.gemini/antigravity*`.

1. **Follow the Project Blackboard**: Check `[agy-memory]` startup header (`id`, `scope`, inline entries or key index). If it shows a key index, call `board_read(conversationId="<id>")` before acting on project rules or open handoffs. Current board entries override older transcripts.
2. **Keep the board current**: Call `board_post(conversationId="<id>", key="<slug>", body="...")` for continuing project rules, accepted decisions, or open handoffs (`scope="global"` for personal cross-project preferences). Pass `expectedRevision` to update a changed decision or set `delete=true` when a handoff finishes. Never store secrets.
3. **Scoped archive verification**: Pass `conversationId="<id>"` to `search_sessions` (stays inside current project and excludes current session; pass `allScopes=true` only for other projects). Omit `query` to list recent sessions. Use `mode="file_history"` for edits vs reads and `mode="error_history"` for command/test failures even with a filename. Never treat `INCOMPLETE SCAN` 0-matches as absence. Read returned `.md` files >100 lines directly via `read_file`.
4. **Swarm workers (no MCP)**: Run `node "<plugin>/dist/mcp-server.mjs" --cli board-read|board-post|search|read ...`.
