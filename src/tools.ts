import { recallNotesResult, saveNoteResult } from "./notes.js";
import { searchSessionsResult } from "./search.js";
import { listSessionsResult, readSessionResult, resolveDataDir } from "./store.js";
import type { ToolResult } from "./types.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_sessions",
    description:
      "List recent local Antigravity conversations (titles, IDs, workspaces, step counts, substantive latest prompt, swarm/artifact badges). Fast read-only catalog query, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path (exact/child match) or folder name filter.",
        },
        query: {
          type: "string",
          description: "Optional multi-word filter (supports quoted phrases) matched against title, preview, ID, workspace, and last user message.",
        },
        includeChildren: {
          type: "boolean",
          description: "Include subagent and Swarm worker child conversations (default false).",
        },
        excludeSessionId: {
          type: "string",
          description: "Optional conversation ID or prefix (>=4 chars, or comma-separated list) to exclude (e.g. current session).",
        },
        sinceHours: {
          type: "number",
          description: "Optional recency window in hours.",
        },
        minSteps: {
          type: "integer",
          description: "Optional minimum step count to filter out tiny/probe sessions (e.g. 5).",
        },
        limit: {
          type: "integer",
          description: "Maximum sessions to return (1..50, default 15).",
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200).",
        },
      },
    },
  },
  {
    name: "search_sessions",
    description:
      "Search across past local Antigravity conversations (CJK and English supported) covering user prompts, assistant replies (including hydrated full responses), Markdown artifacts, and Swarm boards. Returns ranked, term-diverse excerpts with session IDs, step numbers, and artifact paths.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords (multi-word AND, supports quoted phrases) or regex when regex=true.",
        },
        scope: {
          type: "string",
          enum: ["all", "user", "assistant", "artifacts", "swarm"],
          description: "Where to search (default 'all'; strictly scoped when not 'all').",
        },
        regex: {
          type: "boolean",
          description: "Treat query as a case-insensitive regular expression (default false).",
        },
        sessionId: {
          type: "string",
          description: "Optional full UUID or prefix (>=4 chars) to search within a single specific conversation.",
        },
        workspace: {
          type: "string",
          description: "Optional workspace path (exact/child match) or folder name filter.",
        },
        includeChildren: {
          type: "boolean",
          description: "Include subagent/Swarm worker child conversations (default false).",
        },
        excludeSessionId: {
          type: "string",
          description: "Optional conversation ID or prefix (>=4 chars, or comma-separated list) to exclude (e.g. current session).",
        },
        sinceDays: {
          type: "number",
          description: "Optional recency window in days.",
        },
        maxSessions: {
          type: "integer",
          description: "Maximum matching conversations to return (1..25, default 10).",
        },
        maxSnippetsPerSession: {
          type: "integer",
          description: "Maximum term-diverse excerpts per conversation (1..8, default 3).",
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_session",
    description:
      "Read a specific past conversation by full UUID or prefix (>=4 chars). Use mode='digest' first for an overview of turns + artifacts + Swarm summary, then 'turns' (auto-hydrates truncated full replies, supports charOffset), 'artifacts', or 'swarm' (preserves newest messages, supports startSeq/endSeq/query).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Full conversation UUID or unambiguous prefix (e.g. 'a1b2c3d4').",
        },
        mode: {
          type: "string",
          enum: ["digest", "turns", "artifacts", "swarm"],
          description: "View mode (default 'digest').",
        },
        startStep: {
          type: "integer",
          description: "For mode='turns': inclusive starting step index.",
        },
        endStep: {
          type: "integer",
          description: "For mode='turns': inclusive ending step index.",
        },
        tailTurns: {
          type: "integer",
          description: "For mode='turns' without step bounds: last N turns to show (1..40, default 6).",
        },
        charOffset: {
          type: "integer",
          description: "For mode='turns': starting character offset to continue reading a large >8.2 KB turn.",
        },
        includeTools: {
          type: "boolean",
          description: "For mode='turns': include tool call count summary per turn (default false).",
        },
        includeThinking: {
          type: "boolean",
          description: "For mode='turns': include truncated thinking text (default false).",
        },
        artifactName: {
          type: "string",
          description: "For mode='artifacts': specific Markdown artifact filename to read.",
        },
        startLine: {
          type: "integer",
          description: "For mode='artifacts' with artifactName: 1-based start line (default 1).",
        },
        endLine: {
          type: "integer",
          description: "For mode='artifacts' with artifactName: 1-based inclusive end line (default 180).",
        },
        tailMessages: {
          type: "integer",
          description: "For mode='swarm': last N board messages to show (1..100, default 20; newest preserved within budget).",
        },
        startSeq: {
          type: "integer",
          description: "For mode='swarm': inclusive starting message sequence number (#seq).",
        },
        endSeq: {
          type: "integer",
          description: "For mode='swarm': inclusive ending message sequence number (#seq).",
        },
        query: {
          type: "string",
          description: "For mode='swarm': optional multi-word AND filter matched against board agent and text.",
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200).",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "save_note",
    description:
      "Save, update, or delete a curated cross-session memory note stored persistently on disk (outside any single conversation). Never store secrets or tokens.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short descriptive title/topic of the note.",
        },
        content: {
          type: "string",
          description: "Concise fact, decision, conclusion, or preference to remember across sessions.",
        },
        workspace: {
          type: "string",
          description: "Optional workspace path this note applies to (omit for global notes).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for recall filtering.",
        },
        sessionId: {
          type: "string",
          description: "Optional source conversation ID.",
        },
        id: {
          type: "string",
          description: "Optional existing note ID to update in place.",
        },
        deleteId: {
          type: "string",
          description: "If set, deletes the note with this ID instead of saving.",
        },
      },
    },
  },
  {
    name: "recall_notes",
    description:
      "Recall previously saved cross-session memory notes filtered by query (matches ID, topic, content, tags, workspace), workspace, or tag.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional multi-word search query (supports quoted phrases).",
        },
        workspace: {
          type: "string",
          description: "Optional workspace path filter (also keeps global and parent-workspace notes).",
        },
        tag: {
          type: "string",
          description: "Optional exact tag filter.",
        },
        limit: {
          type: "integer",
          description: "Maximum notes to return (1..30, default 15).",
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200).",
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
    case "save_note":
      return saveNoteResult({
        dataDir,
        id: asString(args.id),
        deleteId: asString(args.deleteId),
        topic: asString(args.topic),
        content: asString(args.content),
        workspace: asString(args.workspace),
        tags: Array.isArray(args.tags)
          ? (args.tags as string[])
          : typeof args.tags === "string"
            ? args.tags
            : [],
        sessionId: asString(args.sessionId),
      });
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
