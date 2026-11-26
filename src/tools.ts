import { boardPostResult, boardReadResult } from "./board.js";
import { parseExplicitScopeKey } from "./scope.js";
import { searchSessionsResult } from "./search.js";
import { readSessionResult, resolveConversationContext } from "./store.js";
import type { BoardSourceRef, ScopeKey, ToolResult } from "./types.js";

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

const READ_ONLY_LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "board_read",
    description:
      "Read active Project Blackboard entries (decisions, conventions, handoffs) with revisions, source sessions, and paths. Local read-only.",
    annotations: { title: "Read Project Blackboard", ...READ_ONLY_LOCAL },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Current session UUID from [agy-memory] header." },
        scope: { type: "string", default: "all", description: "'all' (project+global), 'project', 'global', or explicit scope key." },
        keys: { type: "array", items: { type: "string" }, description: "Optional entry keys to fetch." },
        query: { type: "string", description: "Optional AND filter." },
        offset: { type: "integer", minimum: 0, description: "Entry paging offset." },
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." },
      },
    },
  },
  {
    name: "board_post",
    description:
      "Create, replace, or delete one keyed Project Blackboard entry (entries/<key>.md). Updates and deletes require expectedRevision.",
    annotations: {
      title: "Update Project Blackboard",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", minLength: 1, description: "Lowercase slug key (1..64 of a-z, 0-9, '.', '_', '-')." },
        body: { type: "string", description: "Markdown body (required unless delete=true)." },
        title: { type: "string", description: "Optional short title." },
        conversationId: { type: "string", description: "Current session UUID from [agy-memory] header." },
        step: { type: "integer", minimum: 0, description: "Optional source step." },
        scope: { type: "string", default: "project", description: "'project' (default), 'global', or explicit scope key." },
        expectedRevision: { type: "string", description: "12-char revision hash for updates/deletes." },
        delete: { type: "boolean", default: false, description: "Set true with expectedRevision to remove entry." },
      },
      required: ["key"],
    },
  },
  {
    name: "search_sessions",
    description:
      "List or search local Antigravity sessions (App/CLI/IDE). Omit query to list. Modes: 'text' (replies/artifacts/Swarm), 'file_history' (writes vs reads), 'error_history' (failed commands/tests — use even with a filename). Pass conversationId to scope to current project or allScopes=true for all projects.",
    annotations: { title: "List or Search Past Sessions", ...READ_ONLY_LOCAL },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "AND keywords, regex, file path, or error text. Omit in text mode to list." },
        mode: { type: "string", enum: ["text", "file_history", "error_history"], default: "text", description: "'text', 'file_history', or 'error_history'." },
        scope: { type: "string", enum: ["all", "user", "assistant", "artifacts", "swarm"], default: "all", description: "Text sub-scope." },
        regex: { type: "boolean", default: false, description: "Case-insensitive regex in text mode." },
        conversationId: { type: "string", description: "Current session UUID (restricts to project scope and excludes self)." },
        allScopes: { type: "boolean", default: false, description: "Search across all projects." },
        sessionId: { type: "string", description: "Restrict to one session UUID or prefix (>=4 chars)." },
        workspace: { type: "string", description: "Optional workspace path filter." },
        includeChildren: { type: "boolean", default: false, description: "Include subagent/Swarm children." },
        excludeSessionId: { type: "string", description: "Comma-separated IDs/prefixes to exclude." },
        sinceDays: { type: "number", minimum: 0, description: "Only sessions within last N days." },
        maxSessions: { type: "integer", minimum: 1, maximum: 25, description: "Max sessions (default 10)." },
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." },
      },
    },
  },
  {
    name: "read_session",
    description:
      "Read one local Antigravity session by UUID or prefix (>=4 chars): 'digest', 'turns' (hydrated, charOffset paging), 'artifacts', or 'swarm' (newest-first).",
    annotations: { title: "Read Past Session", ...READ_ONLY_LOCAL },
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1, description: "Session UUID or prefix (>=4 chars)." },
        mode: { type: "string", enum: ["digest", "turns", "artifacts", "swarm"], default: "digest", description: "View mode." },
        startStep: { type: "integer", minimum: 0, description: "turns: start step." },
        endStep: { type: "integer", minimum: 0, description: "turns: end step." },
        tailTurns: { type: "integer", minimum: 1, maximum: 40, description: "turns: last N turns." },
        charOffset: { type: "integer", minimum: 0, description: "turns: paging offset." },
        includeTools: { type: "boolean", default: false, description: "turns: tool counts." },
        includeThinking: { type: "boolean", default: false, description: "turns: thinking excerpt." },
        artifactName: { type: "string", description: "artifacts: filename (omit to list)." },
        startLine: { type: "integer", minimum: 1, description: "artifacts: start line." },
        endLine: { type: "integer", minimum: 1, description: "artifacts: end line." },
        tailMessages: { type: "integer", minimum: 1, maximum: 100, description: "swarm: last N messages." },
        startSeq: { type: "integer", minimum: 1, description: "swarm: start #seq." },
        endSeq: { type: "integer", minimum: 1, description: "swarm: end #seq." },
        query: { type: "string", description: "swarm: filter text/agent." },
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." },
      },
      required: ["sessionId"],
    },
  },
];

export interface ExecuteToolOptions {
  dataDir?: string;
  boardsHome?: string;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function asOptionalNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseStrictBool(v: unknown, name: string): { value: boolean; error?: string } {
  if (v === undefined || v === null) return { value: false };
  if (typeof v === "boolean") return { value: v };
  if (typeof v === "string") {
    const norm = v.trim().toLowerCase();
    if (norm === "" || norm === "false" || norm === "0") return { value: false };
    if (norm === "true" || norm === "1") return { value: true };
  }
  return { value: false, error: `Error: Invalid boolean value "${String(v)}" for ${name}. Expected true or false.` };
}

function resolveBoardToolScope(opts: {
  rawScope: string;
  conversationId: string;
  dataDir: string;
  defaultScope: "all" | "project";
}): { scope: ScopeKey; includeGlobal: boolean; source?: BoardSourceRef; error?: string } {
  const scopeStr = opts.rawScope.trim() || opts.defaultScope;
  const cid = opts.conversationId.trim();

  if (scopeStr === "global") {
    const source = cid ? { client: "cli" as const, conversationId: cid } : undefined;
    return { scope: { kind: "global" }, includeGlobal: false, source };
  }

  const explicit = parseExplicitScopeKey(scopeStr);
  if (explicit) {
    let source: BoardSourceRef | undefined;
    if (cid) {
      const ctx = resolveConversationContext({ conversationId: cid, overrideDataDir: opts.dataDir });
      source = { client: ctx.scopeKey.kind !== "unresolved" ? ctx.client : "cli", conversationId: cid };
    }
    return { scope: explicit, includeGlobal: false, source };
  }

  if (scopeStr !== "project" && scopeStr !== "all") {
    return {
      scope: { kind: "unresolved" },
      includeGlobal: false,
      error: `Error: Invalid scope "${scopeStr}". Expected "project", "global", "all", or an explicit scope key.`,
    };
  }

  if (!cid) {
    return {
      scope: { kind: "unresolved" },
      includeGlobal: false,
      error:
        'Error: Pass conversationId (from [agy-memory] startup header) or scope="global" so board access stays isolated to the right project.',
    };
  }

  const ctx = resolveConversationContext({ conversationId: cid, overrideDataDir: opts.dataDir });
  if (ctx.scopeKey.kind === "unresolved") {
    return {
      scope: ctx.scopeKey,
      includeGlobal: false,
      error: `Error: Could not resolve project scope for conversation "${cid}"${ctx.diagnostic ? ` (${ctx.diagnostic})` : ""}.`,
    };
  }

  return {
    scope: ctx.scopeKey,
    includeGlobal: scopeStr === "all",
    source: { client: ctx.client, conversationId: cid },
  };
}

export function executeToolResult(
  name: string,
  rawArgs: Record<string, unknown> = {},
  opts: ExecuteToolOptions = {},
): ToolResult {
  const dataDir = opts.dataDir ?? "";
  const boardsHome = opts.boardsHome ?? "";
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};

  switch (name) {
    case "board_read": {
      const resolved = resolveBoardToolScope({
        rawScope: asString(args.scope),
        conversationId: asString(args.conversationId),
        dataDir,
        defaultScope: "all",
      });
      if (resolved.error) return { text: resolved.error, isError: true };
      const keys = Array.isArray(args.keys)
        ? (args.keys as unknown[]).map(asString).filter(Boolean)
        : typeof args.keys === "string" && args.keys.trim()
          ? args.keys.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
      return boardReadResult({
        scope: resolved.scope,
        includeGlobal: resolved.includeGlobal,
        keys,
        query: asString(args.query),
        offset: asOptionalNumber(args.offset),
        maxChars: asOptionalNumber(args.maxChars),
        boardsHome,
      });
    }
    case "board_post": {
      const deleteFlag = parseStrictBool(args.delete, "delete");
      if (deleteFlag.error) return { text: deleteFlag.error, isError: true };
      const resolved = resolveBoardToolScope({
        rawScope: asString(args.scope),
        conversationId: asString(args.conversationId),
        dataDir,
        defaultScope: "project",
      });
      if (resolved.error) return { text: resolved.error, isError: true };
      const step = asOptionalNumber(args.step);
      const source: BoardSourceRef | undefined = resolved.source
        ? { ...resolved.source, ...(step !== undefined && step >= 0 ? { step: Math.floor(step) } : {}) }
        : undefined;
      return boardPostResult({
        scope: resolved.scope,
        key: asString(args.key),
        title: asString(args.title),
        body: asString(args.body),
        delete: deleteFlag.value,
        expectedRevision: asString(args.expectedRevision),
        source,
        boardsHome,
      });
    }
    case "search_sessions": {
      const regexFlag = parseStrictBool(args.regex, "regex");
      const allScopesFlag = parseStrictBool(args.allScopes, "allScopes");
      const includeChildrenFlag = parseStrictBool(args.includeChildren, "includeChildren");
      const boolErr = regexFlag.error || allScopesFlag.error || includeChildrenFlag.error;
      if (boolErr) return { text: boolErr, isError: true };
      return searchSessionsResult({
        dataDir,
        query: asString(args.query),
        mode: asString(args.mode) || "text",
        scope: asString(args.scope) || "all",
        regex: regexFlag.value,
        conversationId: asString(args.conversationId),
        scopeKey: asString(args.scopeKey),
        allScopes: allScopesFlag.value,
        sessionId: asString(args.sessionId),
        workspace: asString(args.workspace),
        includeChildren: includeChildrenFlag.value,
        excludeSessionId: asString(args.excludeSessionId),
        sinceDays: Number(args.sinceDays) || 0,
        maxSessions: asOptionalNumber(args.maxSessions),
        maxChars: asOptionalNumber(args.maxChars),
      });
    }
    case "read_session": {
      const includeToolsFlag = parseStrictBool(args.includeTools, "includeTools");
      const includeThinkingFlag = parseStrictBool(args.includeThinking, "includeThinking");
      const boolErr = includeToolsFlag.error || includeThinkingFlag.error;
      if (boolErr) return { text: boolErr, isError: true };
      return readSessionResult({
        dataDir,
        sessionId: asString(args.sessionId),
        mode: asString(args.mode) || "digest",
        startStep: typeof args.startStep === "number" ? args.startStep : null,
        endStep: typeof args.endStep === "number" ? args.endStep : null,
        tailTurns: asOptionalNumber(args.tailTurns),
        charOffset: typeof args.charOffset === "number" ? args.charOffset : 0,
        includeTools: includeToolsFlag.value,
        includeThinking: includeThinkingFlag.value,
        artifactName: asString(args.artifactName),
        startLine: asOptionalNumber(args.startLine),
        endLine: asOptionalNumber(args.endLine),
        tailMessages: asOptionalNumber(args.tailMessages),
        startSeq: typeof args.startSeq === "number" ? args.startSeq : null,
        endSeq: typeof args.endSeq === "number" ? args.endSeq : null,
        query: asString(args.query),
        maxChars: asOptionalNumber(args.maxChars),
      });
    }
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
