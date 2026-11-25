import { recallNotesResult, saveNoteResult } from "./notes.js";
import { searchSessionsResult } from "./search.js";
import { listSessionsResult, readSessionResult, resolveDataDir } from "./store.js";
import type { ToolResult } from "./types.js";

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

const SOURCE_ENUM = ["agy", "codex", "claude", "all"];

const READ_ONLY_LOCAL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_sessions",
    description:
      "List recent local conversations newest first, returning session IDs, titles, workspaces, timestamps, step counts, and latest prompts. Use to discover session IDs without a search query; use search_sessions to search transcript content, file edits, or command errors, and read_session once you have an ID. Read-only and local-only; active filters combine with AND logic, child sessions are excluded by default, and output truncates at maxChars (default 8200).",
    annotations: {
      title: "List Past Sessions",
      ...READ_ONLY_LOCAL_ANNOTATIONS,
    },
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: SOURCE_ENUM,
          default: "agy",
          description: "CLI source: 'agy' (default), 'codex', 'claude', or 'all'.",
        },
        workspace: {
          type: "string",
          description: "Case-insensitive workspace path substring filter.",
        },
        query: {
          type: "string",
          description: "AND-matched keywords (quoted phrases supported) across title, ID, workspace, preview, and latest prompt.",
        },
        includeChildren: {
          type: "boolean",
          default: false,
          description: "Include subagent and Swarm worker child sessions (default false).",
        },
        excludeSessionId: {
          type: "string",
          description: "Comma-separated session IDs, prefixes, or qualified IDs (e.g. 'agy:<id>') to omit.",
        },
        sinceHours: {
          type: "number",
          minimum: 0,
          description: "Only sessions updated within the last N hours (0 disables).",
        },
        minSteps: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Minimum step count (e.g. 5 to skip trivial sessions; default 0).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 15,
          description: "Max rows to return (1..50, default 15).",
        },
        maxChars: {
          type: "integer",
          minimum: 200,
          maximum: 8200,
          default: 8200,
          description: "Output char cap before truncation (200..8200, default 8200).",
        },
      },
    },
  },
  {
    name: "search_sessions",
    description:
      "Search past local conversations by text, file edit/read history, or command failure history, returning grouped session IDs with #step citations and excerpts. Use list_sessions to browse without a query, read_session to inspect a known session, and recall_notes for saved notes. Choose mode='text' (default) to search replies, artifacts, and Swarm boards across agy/codex/claude (optional scope and regex); mode='file_history' for verified agy file writes vs reads; or mode='error_history' for failed commands, test failures, and non-zero exit codes (always use error_history for failures, even when querying a filename). Read-only and local-only; output caps at maxChars (default 8200) and emits INCOMPLETE SCAN if scan limits are hit (narrow via workspace, sinceDays, or sessionId).",
    annotations: {
      title: "Search Past Sessions",
      ...READ_ONLY_LOCAL_ANNOTATIONS,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description:
            "AND keywords (quoted phrases supported), regex (when regex=true), file path/basename (file_history), or command/error/filename text (error_history).",
        },
        mode: {
          type: "string",
          enum: ["text", "file_history", "error_history"],
          default: "text",
          description:
            "'text' (default: replies/artifacts/Swarm), 'file_history' (verified agy file writes vs reads), or 'error_history' (failed commands/tests/exit codes in agy — use even when querying a filename).",
        },
        source: {
          type: "string",
          enum: SOURCE_ENUM,
          default: "agy",
          description: "CLI source for text mode (default 'agy'; overridden by qualified sessionId like 'codex:<id>').",
        },
        scope: {
          type: "string",
          enum: ["all", "user", "assistant", "artifacts", "swarm"],
          default: "all",
          description: "Sub-scope for mode='text' only (default 'all').",
        },
        regex: {
          type: "boolean",
          default: false,
          description: "Treat query as case-insensitive regex in mode='text' (default false).",
        },
        sessionId: {
          type: "string",
          description: "Restrict to one session by full ID, unique prefix (>=4 chars), or qualified ID ('codex:<id>').",
        },
        workspace: {
          type: "string",
          description: "Case-insensitive workspace path substring filter.",
        },
        includeChildren: {
          type: "boolean",
          default: false,
          description: "Include subagent and Swarm worker child sessions (default false).",
        },
        excludeSessionId: {
          type: "string",
          description: "Comma-separated session IDs, prefixes, or qualified IDs (e.g. 'agy:<id>') to omit.",
        },
        sinceDays: {
          type: "number",
          minimum: 0,
          description: "Only scan sessions updated within the last N days (0 disables).",
        },
        maxSessions: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          default: 10,
          description: "Max matching sessions (1..25, default 10).",
        },
        maxSnippetsPerSession: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          default: 3,
          description: "Max excerpts/events per session (1..8, default 3).",
        },
        maxChars: {
          type: "integer",
          minimum: 200,
          maximum: 8200,
          default: 8200,
          description: "Output char cap before truncation (200..8200, default 8200).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_session",
    description:
      "Read detailed content from one known local session by full ID, unique prefix (>=4 chars), or qualified ID (e.g. 'codex:<id>'). Use after getting an ID from list_sessions or search_sessions; do not use to browse or search across sessions. Select one view via mode: 'digest' (default) gives a per-turn outline, artifact paths, and Swarm summary; 'turns' returns full hydrated turns by startStep/endStep or tailTurns (default 6), with optional tool counts or thinking; 'artifacts' lists session Markdown files with paths or reads artifactName by startLine/endLine; 'swarm' returns the Swarm roster and board messages by seq range, tailMessages, or query. Read-only and local-only; output truncates at maxChars (default 8200)—in mode='turns', pass the next charOffset to page through turns larger than maxChars.",
    annotations: {
      title: "Read Past Session",
      ...READ_ONLY_LOCAL_ANNOTATIONS,
    },
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description: "Target session full UUID, unique prefix (>=4 chars), or qualified ID ('agy:<id>', 'codex:<id>', 'claude:<id>').",
        },
        source: {
          type: "string",
          enum: SOURCE_ENUM,
          default: "agy",
          description: "CLI source for resolving sessionId (default 'agy'; overridden by 'source:' prefix).",
        },
        mode: {
          type: "string",
          enum: ["digest", "turns", "artifacts", "swarm"],
          default: "digest",
          description: "View mode: 'digest' (default overview), 'turns', 'artifacts', or 'swarm'.",
        },
        startStep: {
          type: "integer",
          minimum: 0,
          description: "mode='turns': inclusive start step (overrides tailTurns).",
        },
        endStep: {
          type: "integer",
          minimum: 0,
          description: "mode='turns': inclusive end step.",
        },
        tailTurns: {
          type: "integer",
          minimum: 1,
          maximum: 40,
          default: 6,
          description: "mode='turns': last N turns when step bounds are omitted (1..40, default 6).",
        },
        charOffset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "mode='turns': character offset for paging turns exceeding maxChars (default 0).",
        },
        includeTools: {
          type: "boolean",
          default: false,
          description: "mode='turns': include per-turn tool call counts (default false).",
        },
        includeThinking: {
          type: "boolean",
          default: false,
          description: "mode='turns': include truncated thinking text (default false).",
        },
        artifactName: {
          type: "string",
          description: "mode='artifacts': filename to read (omit to list all artifacts and paths).",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          default: 1,
          description: "mode='artifacts' with artifactName: 1-based start line (default 1).",
        },
        endLine: {
          type: "integer",
          minimum: 1,
          default: 180,
          description: "mode='artifacts' with artifactName: 1-based inclusive end line (default 180).",
        },
        tailMessages: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "mode='swarm': last N board messages when seq bounds are omitted (1..100, default 20).",
        },
        startSeq: {
          type: "integer",
          minimum: 1,
          description: "mode='swarm': inclusive starting board #seq.",
        },
        endSeq: {
          type: "integer",
          minimum: 1,
          description: "mode='swarm': inclusive ending board #seq.",
        },
        query: {
          type: "string",
          description: "mode='swarm': filter board messages by agent name or text.",
        },
        maxChars: {
          type: "integer",
          minimum: 200,
          maximum: 8200,
          default: 8200,
          description: "Output char cap before truncation (200..8200, default 8200).",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "save_note",
    description:
      "Create, update, or permanently delete a local cross-session Markdown note stored under topics/<id>.md and indexed in MEMORY.md. Use only to persist or remove durable decisions and preferences; use recall_notes for read-only lookups, and never store secrets or tokens. Mutates local files under a lock (deleteId is irreversible) with no network calls: pass topic and content to create or upsert by topic+workspace, add id to update in place (omitting workspace or tags preserves existing values), or pass deleteId alone to remove a note. Returns ID, file Path, and 12-char Revision; pass expectedRevision on updates/deletes to reject stale concurrent writes without overwriting.",
    annotations: {
      title: "Save, Update, or Delete Memory Note",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short note title (required for create/update; ignored with deleteId).",
        },
        content: {
          type: "string",
          description: "Markdown note body (required for create/update; ignored with deleteId).",
        },
        workspace: {
          type: "string",
          description: "Optional workspace scope (omit on create for global; omit on id update to preserve).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional recall tags (omit on id update to preserve).",
        },
        sessionId: {
          type: "string",
          description: "Optional source session ID recorded in frontmatter.",
        },
        id: {
          type: "string",
          description: "Optional note ID (1..64 ASCII letters, digits, '_' or '-') to update in place or name on create.",
        },
        expectedRevision: {
          type: "string",
          description: "12-char Revision hash from recall_notes/save_note; rejects stale updates/deletes without modifying disk.",
        },
        deleteId: {
          type: "string",
          description: "Note ID to permanently delete (mutually exclusive with create/update; pair with expectedRevision).",
        },
      },
    },
  },
  {
    name: "recall_notes",
    description:
      "Read and filter saved local cross-session Markdown notes, returning each note's ID, topic, preview, file Path, and Revision hash. Use before starting work or updating notes; use save_note to create, edit, or delete notes, and search_sessions for raw conversation logs. Read-only and local-only; query uses AND-matched keywords/phrases across all fields, workspace also retains global and parent-directory notes, and tag matches exactly (case-insensitive). Defaults to limit=15 and truncates at maxChars (default 8200); read long notes directly via the returned Path.",
    annotations: {
      title: "Recall Memory Notes",
      ...READ_ONLY_LOCAL_ANNOTATIONS,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "AND keywords (quoted phrases supported) across ID, topic, content, tags, and workspace.",
        },
        workspace: {
          type: "string",
          description: "Workspace filter (also keeps global and parent-directory notes).",
        },
        tag: {
          type: "string",
          description: "Exact case-insensitive tag filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          default: 15,
          description: "Max notes to return (1..30, default 15).",
        },
        maxChars: {
          type: "integer",
          minimum: 200,
          maximum: 8200,
          default: 8200,
          description: "Output char cap before truncation (200..8200, default 8200).",
        },
      },
    },
  },
];

export interface ExecuteToolOptions {
  dataDir?: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function asOptionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function executeToolResult(
  name: string,
  rawArgs: Record<string, unknown> = {},
  opts: ExecuteToolOptions = {},
): ToolResult {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  switch (name) {
    case "list_sessions":
      return listSessionsResult({
        dataDir,
        source: asString(args.source) || "agy",
        workspace: asString(args.workspace),
        query: asString(args.query),
        includeChildren: Boolean(args.includeChildren),
        excludeSessionId: asString(args.excludeSessionId),
        sinceHours: Number(args.sinceHours) || 0,
        minSteps: Number(args.minSteps) || 0,
        limit: asOptionalNumber(args.limit),
        maxChars: asOptionalNumber(args.maxChars),
      });
    case "search_sessions":
      return searchSessionsResult({
        dataDir,
        query: asString(args.query),
        mode: asString(args.mode) || "text",
        source: asString(args.source) || "agy",
        scope: asString(args.scope) || "all",
        regex: Boolean(args.regex),
        sessionId: asString(args.sessionId),
        workspace: asString(args.workspace),
        includeChildren: Boolean(args.includeChildren),
        excludeSessionId: asString(args.excludeSessionId),
        sinceDays: Number(args.sinceDays) || 0,
        maxSessions: asOptionalNumber(args.maxSessions),
        maxSnippetsPerSession: asOptionalNumber(args.maxSnippetsPerSession),
        maxChars: asOptionalNumber(args.maxChars),
      });
    case "read_session":
      return readSessionResult({
        dataDir,
        source: asString(args.source) || "agy",
        sessionId: asString(args.sessionId),
        mode: asString(args.mode) || "digest",
        startStep: typeof args.startStep === "number" ? args.startStep : null,
        endStep: typeof args.endStep === "number" ? args.endStep : null,
        tailTurns: asOptionalNumber(args.tailTurns),
        charOffset: typeof args.charOffset === "number" ? args.charOffset : 0,
        includeTools: Boolean(args.includeTools),
        includeThinking: Boolean(args.includeThinking),
        artifactName: asString(args.artifactName),
        startLine: asOptionalNumber(args.startLine),
        endLine: asOptionalNumber(args.endLine),
        tailMessages: asOptionalNumber(args.tailMessages),
        startSeq: typeof args.startSeq === "number" ? args.startSeq : null,
        endSeq: typeof args.endSeq === "number" ? args.endSeq : null,
        query: asString(args.query),
        maxChars: asOptionalNumber(args.maxChars),
      });
    case "save_note": {
      const hasWs = Object.prototype.hasOwnProperty.call(args, "workspace") && args.workspace !== undefined;
      const hasTags = Object.prototype.hasOwnProperty.call(args, "tags") && args.tags !== undefined;
      return saveNoteResult({
        dataDir,
        id: asString(args.id),
        deleteId: asString(args.deleteId),
        topic: asString(args.topic),
        content: asString(args.content),
        workspace: hasWs ? asString(args.workspace) : undefined,
        tags: hasTags
          ? Array.isArray(args.tags)
            ? (args.tags as string[])
            : typeof args.tags === "string"
              ? args.tags
              : []
          : undefined,
        sessionId: asString(args.sessionId),
        expectedRevision: asString(args.expectedRevision),
      });
    }
    case "recall_notes":
      return recallNotesResult({
        dataDir,
        query: asString(args.query),
        workspace: asString(args.workspace),
        tag: asString(args.tag),
        limit: asOptionalNumber(args.limit),
        maxChars: asOptionalNumber(args.maxChars),
      });
    default:
      return { text: `Error: Unknown tool: ${name}`, isError: true };
  }
}

export function executeTool(
  name: string,
  rawArgs: Record<string, unknown> = {},
  opts: ExecuteToolOptions = {},
): string {
  return executeToolResult(name, rawArgs, opts).text;
}
