import { recallNotesResult, saveNoteResult } from "./notes.js";
import { searchSessionsResult } from "./search.js";
import { listSessionsResult, readSessionResult, resolveDataDir } from "./store.js";
import type { ToolResult } from "./types.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SOURCE_ENUM = ["agy", "codex", "claude", "all"];

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "list_sessions",
    description: "List recent local conversations (read-only catalog, newest first).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy)." },
        workspace: { type: "string", description: "Workspace filter." },
        query: { type: "string", description: "Filter title, ID, workspace, prompt." },
        includeChildren: { type: "boolean", description: "Include child workers." },
        excludeSessionId: { type: "string", description: "ID/prefix list (e.g. agy:<id>)." },
        sinceHours: { type: "number", description: "Hours lookback." },
        minSteps: { type: "integer", description: "Min steps (e.g. 5)." },
        limit: { type: "integer", description: "Max rows (1..50)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." },
      },
    },
  },
  {
    name: "search_sessions",
    description:
      "Search past conversations (text, file_history, or error_history). Text searches replies/artifacts/Swarm (+Codex/Claude); for failed commands, test failures, or exit codes use mode='error_history' even when querying a filename.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords/phrase, regex, file path, or error text." },
        mode: {
          type: "string",
          enum: ["text", "file_history", "error_history"],
          description:
            "text (default: replies/artifacts/swarm), file_history (file edit vs read history, agy), or error_history (failed commands, test failures, or exit codes, agy — use error_history even when querying a filename).",
        },
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy; all=agy+codex+claude)." },
        scope: { type: "string", enum: ["all", "user", "assistant", "artifacts", "swarm"], description: "Text scope." },
        regex: { type: "boolean", description: "Regex in text mode." },
        sessionId: { type: "string", description: "Single session ID/prefix (or codex:<id>)." },
        workspace: { type: "string", description: "Workspace filter." },
        includeChildren: { type: "boolean", description: "Include child workers." },
        excludeSessionId: { type: "string", description: "ID/prefix list (e.g. agy:<id>)." },
        sinceDays: { type: "number", description: "Days lookback." },
        maxSessions: { type: "integer", description: "Max sessions (1..25)." },
        maxSnippetsPerSession: { type: "integer", description: "Excerpts/session (1..8)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." },
      },
      required: ["query"],
    },
  },
  {
    name: "read_session",
    description: "Read a past session by ID/prefix (digest, turns+charOffset, artifacts, swarm).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "ID, prefix (>=4), or source:id." },
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy)." },
        mode: { type: "string", enum: ["digest", "turns", "artifacts", "swarm"], description: "View mode." },
        startStep: { type: "integer", description: "turns: start step." },
        endStep: { type: "integer", description: "turns: end step." },
        tailTurns: { type: "integer", description: "turns: last N (1..40)." },
        charOffset: { type: "integer", description: "turns: >8.2KB offset." },
        includeTools: { type: "boolean", description: "turns: tool counts." },
        includeThinking: { type: "boolean", description: "turns: thinking." },
        artifactName: { type: "string", description: "artifacts: filename." },
        startLine: { type: "integer", description: "artifacts: start line." },
        endLine: { type: "integer", description: "artifacts: end line." },
        tailMessages: { type: "integer", description: "swarm: last N (1..100)." },
        startSeq: { type: "integer", description: "swarm: start #seq." },
        endSeq: { type: "integer", description: "swarm: end #seq." },
        query: { type: "string", description: "swarm: agent/text filter." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "save_note",
    description:
      "Save, update, or delete an editable Markdown note (topics/<id>.md + MEMORY.md index). Returns Revision; expectedRevision rejects stale writes/deletes without overwriting. Never store secrets.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short descriptive title." },
        content: { type: "string", description: "Markdown note body." },
        workspace: { type: "string", description: "Optional workspace path (omit to preserve on update, or global on create)." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for recall." },
        sessionId: { type: "string", description: "Optional source session ID." },
        id: { type: "string", description: "Existing note ID to update (ASCII alnum/_/-)." },
        expectedRevision: { type: "string", description: "Revision hash from save/recall for safe CAS update/delete." },
        deleteId: { type: "string", description: "Delete note by ID." },
      },
    },
  },
  {
    name: "recall_notes",
    description: "Recall saved Markdown notes (returns file Path and Revision for direct read_file or CAS updates).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Multi-word/quoted filter on ID, topic, content, tags, workspace." },
        workspace: { type: "string", description: "Workspace filter (keeps global/parent notes)." },
        tag: { type: "string", description: "Exact tag filter." },
        limit: { type: "integer", description: "Max notes (1..30, default 15)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." },
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
