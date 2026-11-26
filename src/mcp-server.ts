import { migrateLegacyNotes } from "./board.js";
import { parseExplicitScopeKey } from "./scope.js";
import { resolveDataDir } from "./store.js";
import { executeToolResult, TOOL_DEFINITIONS } from "./tools.js";

const SERVER_INFO = {
  name: "agy-memory",
  version: "0.4.1",
};

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function handleJsonRpcMessage(msg: unknown): JsonRpcResponse | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request",
      },
    };
  }

  const record = msg as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(record, "id") && record.id !== undefined;
  const id = (hasId ? record.id : null) as JsonRpcId;
  const method = record.method;
  const params =
    record.params && typeof record.params === "object" && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {};

  if (typeof method !== "string" || !method.trim()) {
    return {
      jsonrpc: "2.0",
      id: hasId ? id : null,
      error: {
        code: -32600,
        message: "Invalid Request: missing method",
      },
    };
  }

  if (!hasId || id === null) {
    return null;
  }

  try {
    if (method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions:
            "Project Blackboard and Verbatim Session Archive for Google Antigravity. Read/update active project decisions and handoffs with board_read and board_post (pass conversationId from [agy-memory] startup header; pass expectedRevision to update or delete). List or search past sessions/edits/errors with search_sessions (omit query to list; use mode='error_history' for failures) and inspect one session with read_session.",
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOL_DEFINITIONS },
      };
    }

    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }

    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }

    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }

    if (method === "tools/call") {
      const toolName = String(params.name ?? "");
      const toolArgs =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      const { text, isError } = executeToolResult(toolName, toolArgs);
      const resultPayload: Record<string, unknown> = {
        content: [{ type: "text", text }],
      };
      if (isError) {
        resultPayload.isError = true;
      }
      return {
        jsonrpc: "2.0",
        id,
        result: resultPayload,
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: `Error: ${errMsg}` }],
      },
    };
  }
}

function findHeaderSeparator(buf: Buffer): { idx: number; sepLen: number } | null {
  const crlfIdx = buf.indexOf("\r\n\r\n");
  if (crlfIdx !== -1) return { idx: crlfIdx, sepLen: 4 };
  const lfIdx = buf.indexOf("\n\n");
  if (lfIdx !== -1) return { idx: lfIdx, sepLen: 2 };
  return null;
}

function runMcpStdioServer(): void {
  let rawBuf: Buffer = Buffer.alloc(0);
  let framingMode: "lsp" | "jsonl" | null = null;

  const sendResponse = (resp: JsonRpcResponse | null): void => {
    if (!resp) return;
    const payload = JSON.stringify(resp);
    if (framingMode === "lsp") {
      const byteLen = Buffer.byteLength(payload, "utf8");
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
    } else {
      process.stdout.write(`${payload}\n`);
    }
  };

  const dispatchRawJson = (rawText: string): void => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) sendResponse(handleJsonRpcMessage(item));
    } else {
      sendResponse(handleJsonRpcMessage(parsed));
    }
  };

  const processBuffer = (): void => {
    while (rawBuf.length > 0) {
      let lead = 0;
      while (lead < rawBuf.length && (rawBuf[lead] === 0x0d || rawBuf[lead] === 0x0a)) {
        lead += 1;
      }
      if (lead > 0) rawBuf = rawBuf.subarray(lead);
      if (rawBuf.length === 0) return;

      const firstByte = rawBuf[0]!;
      const looksLikeJson = firstByte === 0x7b || firstByte === 0x5b;
      if (!looksLikeJson) {
        const sep = findHeaderSeparator(rawBuf);
        if (!sep) return;
        const headerBlock = rawBuf.subarray(0, sep.idx).toString("ascii");
        const lenMatch = /content-length:\s*(\d+)/i.exec(headerBlock);
        if (lenMatch) {
          framingMode = "lsp";
          const bodyLen = Number.parseInt(lenMatch[1]!, 10);
          const bodyStart = sep.idx + sep.sepLen;
          if (rawBuf.length < bodyStart + bodyLen) return;
          const bodyStr = rawBuf.subarray(bodyStart, bodyStart + bodyLen).toString("utf8");
          rawBuf = rawBuf.subarray(bodyStart + bodyLen);
          dispatchRawJson(bodyStr);
          continue;
        }
      }

      const nlIdx = rawBuf.indexOf(0x0a);
      if (nlIdx === -1) return;
      if (!framingMode) framingMode = "jsonl";
      const lineStr = rawBuf.subarray(0, nlIdx).toString("utf8");
      rawBuf = rawBuf.subarray(nlIdx + 1);
      dispatchRawJson(lineStr);
    }
  };

  process.stdin.on("data", (chunk: Buffer | string) => {
    const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    rawBuf = Buffer.concat([rawBuf, bufChunk]);
    processBuffer();
  });

  process.stdin.on("end", () => {
    if (rawBuf.length > 0) {
      const rem = rawBuf.toString("utf8").trim();
      if (rem && (rem.startsWith("{") || rem.startsWith("["))) {
        if (!framingMode) framingMode = "jsonl";
        dispatchRawJson(rem);
      }
    }
  });
}

const BOOLEAN_CLI_FLAGS = new Set([
  "all-scopes",
  "regex",
  "include-children",
  "include-tools",
  "include-thinking",
  "delete",
  "dry-run",
]);

function parseCliArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] ?? "";
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_CLI_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function parseOptionalInt(val: string | boolean | undefined): number | undefined {
  if (val === undefined || val === "" || val === true || val === false) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}

function flagString(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : "";
}

function parseBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
): { value: boolean; error?: string } {
  const v = flags[key];
  if (v === undefined || v === false) return { value: false };
  if (v === true) return { value: true };
  const low = String(v).trim().toLowerCase();
  if (low === "true" || low === "1") return { value: true };
  if (low === "false" || low === "0") return { value: false };
  return { value: false, error: `Error: Invalid boolean value "${v}" for --${key}. Use true or false.` };
}

function runCliMode(argv: string[]): void {
  const { positional, flags } = parseCliArgs(argv);
  const sub = (positional[0] || "help").toLowerCase();
  const execOpts = {
    ...(flagString(flags, "data-dir") ? { dataDir: flagString(flags, "data-dir") } : {}),
    ...(flagString(flags, "boards-home") ? { boardsHome: flagString(flags, "boards-home") } : {}),
  };

  const failBool = (res: { value: boolean; error?: string }): boolean => {
    if (!res.error) return false;
    process.stderr.write(`${res.error}\n`);
    process.exitCode = 1;
    return true;
  };

  if (sub === "list" || sub === "search") {
    const regexFlag = parseBoolFlag(flags, "regex");
    const allScopesFlag = parseBoolFlag(flags, "all-scopes");
    const includeChildrenFlag = parseBoolFlag(flags, "include-children");
    if (failBool(regexFlag) || failBool(allScopesFlag) || failBool(includeChildrenFlag)) return;
    const query = positional.slice(1).join(" ") || flagString(flags, "query");
    const { text, isError } = executeToolResult(
      "search_sessions",
      {
        query: sub === "list" && !query ? "" : query,
        mode: flagString(flags, "mode") || "text",
        scope: flagString(flags, "scope") || "all",
        regex: regexFlag.value,
        conversationId: flagString(flags, "conversation"),
        scopeKey: flagString(flags, "scope-key"),
        allScopes: allScopesFlag.value,
        sessionId: flagString(flags, "session"),
        workspace: flagString(flags, "workspace"),
        includeChildren: includeChildrenFlag.value,
        excludeSessionId: flagString(flags, "exclude"),
        sinceDays: parseOptionalInt(flags["since-days"]),
        maxSessions: parseOptionalInt(flags.limit),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      execOpts,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "read") {
    const toolsFlag = parseBoolFlag(flags, "tools");
    const thinkingFlag = parseBoolFlag(flags, "thinking");
    if (failBool(toolsFlag) || failBool(thinkingFlag)) return;
    const sessionId = positional[1] || flagString(flags, "session");
    const { text, isError } = executeToolResult(
      "read_session",
      {
        sessionId,
        mode: flagString(flags, "mode") || "digest",
        startStep: parseOptionalInt(flags["start-step"]),
        endStep: parseOptionalInt(flags["end-step"]),
        tailTurns: parseOptionalInt(flags.tail),
        charOffset: parseOptionalInt(flags["char-offset"]),
        tailMessages: parseOptionalInt(flags.tail),
        startSeq: parseOptionalInt(flags["start-seq"]),
        endSeq: parseOptionalInt(flags["end-seq"]),
        query: flagString(flags, "query"),
        includeTools: toolsFlag.value,
        includeThinking: thinkingFlag.value,
        artifactName: flagString(flags, "artifact"),
        startLine: parseOptionalInt(flags["start-line"]),
        endLine: parseOptionalInt(flags["end-line"]),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      execOpts,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "board-read") {
    const { text, isError } = executeToolResult(
      "board_read",
      {
        conversationId: flagString(flags, "conversation"),
        scope: flagString(flags, "scope") || "all",
        keys: flagString(flags, "keys"),
        query: positional.slice(1).join(" ") || flagString(flags, "query"),
        offset: parseOptionalInt(flags.offset),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      execOpts,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "board-post") {
    const deleteFlag = parseBoolFlag(flags, "delete");
    if (failBool(deleteFlag)) return;
    const { text, isError } = executeToolResult(
      "board_post",
      {
        key: flagString(flags, "key") || positional[1] || "",
        title: flagString(flags, "title"),
        body: flagString(flags, "body") || positional.slice(2).join(" ") || "",
        conversationId: flagString(flags, "conversation"),
        step: parseOptionalInt(flags.step),
        scope: flagString(flags, "scope") || "project",
        expectedRevision: flagString(flags, "rev"),
        delete: deleteFlag.value,
      },
      execOpts,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "migrate-notes") {
    const rawTarget = flagString(flags, "scope") || "global";
    const parsedTarget = parseExplicitScopeKey(rawTarget);
    if (!parsedTarget) {
      process.stderr.write(`Error: Invalid target --scope "${rawTarget}". Use "global", "project/<id>", "cli_repo/<gitDir>", or "cli_workspace/<dir>".\n`);
      process.exitCode = 1;
      return;
    }
    const sourceDataDir = flagString(flags, "data-dir") || resolveDataDir();
    const res = migrateLegacyNotes({
      sourceDataDir,
      targetScope: parsedTarget,
      boardsHome: execOpts.boardsHome,
    });
    process.stdout.write(
      `Migrated legacy notes from ${sourceDataDir}: imported=${res.imported}, skipped=${res.skipped}\n${res.details.join("\n")}\n`,
    );
    return;
  }

  process.stdout.write(
    [
      `agy-memory v${SERVER_INFO.version} CLI usage:`,
      "  node dist/mcp-server.mjs --cli board-read [--conversation <id> | --scope global|project/<id>] [--keys a,b] [query]",
      "  node dist/mcp-server.mjs --cli board-post --key <slug> --body <md> [--title <t>] [--conversation <id> | --scope global|project/<id>] [--rev <hash>] [--delete]",
      "  node dist/mcp-server.mjs --cli search [--mode text|file_history|error_history] [--conversation <id>] [--all-scopes] [--workspace <dir>] [--limit 10] [query]",
      "  node dist/mcp-server.mjs --cli read <sessionId> [--mode digest|turns|artifacts|swarm] [--tail 20] [--start-seq N] [--end-seq N] [--char-offset N]",
      "  node dist/mcp-server.mjs --cli migrate-notes --scope global|project/<id> [--data-dir <dir>]",
    ].join("\n") + "\n",
  );
}

const cliFlagIdx = process.argv.indexOf("--cli");
if (cliFlagIdx >= 0) {
  runCliMode(process.argv.slice(cliFlagIdx + 1));
} else {
  runMcpStdioServer();
}
