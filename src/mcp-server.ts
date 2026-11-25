import { analyzeMemoryUsage, formatMemoryUsageMarkdown } from "./analytics.js";
import { executeToolResult, TOOL_DEFINITIONS } from "./tools.js";

const SERVER_INFO = {
  name: "agy-memory",
  version: "0.3.0",
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

  // Validate method before notification early-return if an explicit id is present
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

  // Notifications carry no id (or null id for notifications/*) and expect no reply.
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

  const writeResponse = (obj: JsonRpcResponse | JsonRpcResponse[] | null): void => {
    if (!obj) return;
    const body = JSON.stringify(obj);
    if (framingMode === "lsp") {
      const len = Buffer.byteLength(body, "utf8");
      process.stdout.write(`Content-Length: ${len}\r\n\r\n${body}`);
    } else {
      process.stdout.write(`${body}\n`);
    }
  };

  const writeParseError = (): void => {
    writeResponse({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error",
      },
    });
  };

  const dispatchParsed = (parsed: unknown): void => {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: empty batch" },
        });
        return;
      }
      const replies = parsed.map(handleJsonRpcMessage).filter((r): r is JsonRpcResponse => r !== null);
      if (replies.length > 0) writeResponse(replies);
      return;
    }
    const reply = handleJsonRpcMessage(parsed);
    if (reply) writeResponse(reply);
  };

  const drainBuffer = (isEof = false): void => {
    while (rawBuf.length > 0) {
      if (framingMode !== "lsp") {
        let trimStart = 0;
        while (
          trimStart < rawBuf.length &&
          (rawBuf[trimStart] === 0x20 ||
            rawBuf[trimStart] === 0x09 ||
            rawBuf[trimStart] === 0x0d ||
            rawBuf[trimStart] === 0x0a)
        ) {
          trimStart += 1;
        }
        if (trimStart > 0) rawBuf = rawBuf.subarray(trimStart);
        if (rawBuf.length === 0) return;
      }

      if (!framingMode) {
        if (rawBuf[0] === 0x7b || rawBuf[0] === 0x5b) {
          framingMode = "jsonl";
        } else {
          const head = rawBuf.subarray(0, 64).toString("ascii");
          if (/^(?:content-length|content-type|[a-z][a-z0-9-]*)\s*:/i.test(head)) {
            framingMode = "lsp";
          } else if (!isEof && rawBuf.length < 32 && rawBuf.indexOf(0x0a) === -1) {
            return;
          } else {
            framingMode = "jsonl";
          }
        }
      }

      if (framingMode === "lsp") {
        // Trim any leading blank lines between LSP frames
        let trimStart = 0;
        while (
          trimStart < rawBuf.length &&
          (rawBuf[trimStart] === 0x0d || rawBuf[trimStart] === 0x0a)
        ) {
          trimStart += 1;
        }
        if (trimStart > 0) rawBuf = rawBuf.subarray(trimStart);
        if (rawBuf.length === 0) return;

        const sep = findHeaderSeparator(rawBuf);
        if (!sep) return;
        const headerText = rawBuf.subarray(0, sep.idx).toString("ascii");
        const m = /content-length:\s*(\d+)/i.exec(headerText);
        if (!m || !m[1]) {
          rawBuf = rawBuf.subarray(sep.idx + sep.sepLen);
          writeParseError();
          continue;
        }
        const contentLen = Number(m[1]);
        const bodyStart = sep.idx + sep.sepLen;
        const totalNeeded = bodyStart + contentLen;
        if (rawBuf.length < totalNeeded) return;
        const jsonText = rawBuf.subarray(bodyStart, totalNeeded).toString("utf8");
        rawBuf = rawBuf.subarray(totalNeeded);
        try {
          dispatchParsed(JSON.parse(jsonText));
        } catch {
          writeParseError();
        }
      } else {
        const nlIdx = rawBuf.indexOf(0x0a);
        let lineBuf: Buffer;
        if (nlIdx === -1) {
          if (!isEof) return;
          lineBuf = rawBuf;
          rawBuf = Buffer.alloc(0);
        } else {
          lineBuf = rawBuf.subarray(0, nlIdx);
          rawBuf = rawBuf.subarray(nlIdx + 1);
        }
        const line = lineBuf.toString("utf8").trim();
        if (!line) continue;
        try {
          dispatchParsed(JSON.parse(line));
        } catch {
          writeParseError();
        }
      }
    }
  };

  process.stdin.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    rawBuf = rawBuf.length === 0 ? buf : Buffer.concat([rawBuf, buf]);
    drainBuffer(false);
  });

  process.stdin.on("end", () => {
    drainBuffer(true);
    // Let buffered stdout flush cleanly instead of calling abrupt process.exit(0)
    if (process.stdout.writable && !process.stdout.writableEnded) {
      process.stdout.end();
    }
  });
}

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
        if (next !== undefined && !next.startsWith("--")) {
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

function runCliMode(argv: string[]): void {
  const { positional, flags } = parseCliArgs(argv);
  const sub = (positional[0] || "help").toLowerCase();
  const dataDirFlag = flagString(flags, "data-dir");
  const dataDirOpt = dataDirFlag ? { dataDir: dataDirFlag } : {};

  if (sub === "list") {
    const { text, isError } = executeToolResult(
      "list_sessions",
      {
        source: flagString(flags, "source") || "agy",
        workspace: flagString(flags, "workspace"),
        query: positional.slice(1).join(" ") || flagString(flags, "query"),
        includeChildren: Boolean(flags["include-children"]),
        excludeSessionId: flagString(flags, "exclude"),
        sinceHours: parseOptionalInt(flags["since-hours"]),
        minSteps: parseOptionalInt(flags["min-steps"]),
        limit: parseOptionalInt(flags.limit),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      dataDirOpt,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "search") {
    const query = positional.slice(1).join(" ") || flagString(flags, "query");
    const { text, isError } = executeToolResult(
      "search_sessions",
      {
        query,
        mode: flagString(flags, "mode") || "text",
        source: flagString(flags, "source") || "agy",
        scope: flagString(flags, "scope") || "all",
        regex: Boolean(flags.regex),
        sessionId: flagString(flags, "session"),
        workspace: flagString(flags, "workspace"),
        includeChildren: Boolean(flags["include-children"]),
        excludeSessionId: flagString(flags, "exclude"),
        sinceDays: parseOptionalInt(flags["since-days"]),
        maxSessions: parseOptionalInt(flags.limit),
        maxSnippetsPerSession: parseOptionalInt(flags["max-snippets"]),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      dataDirOpt,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "read") {
    const sessionId = positional[1] || flagString(flags, "session");
    const { text, isError } = executeToolResult(
      "read_session",
      {
        sessionId,
        source: flagString(flags, "source") || "agy",
        mode: flagString(flags, "mode") || "digest",
        startStep: parseOptionalInt(flags["start-step"]),
        endStep: parseOptionalInt(flags["end-step"]),
        tailTurns: parseOptionalInt(flags.tail),
        charOffset: parseOptionalInt(flags["char-offset"]),
        tailMessages: parseOptionalInt(flags.tail),
        startSeq: parseOptionalInt(flags["start-seq"]),
        endSeq: parseOptionalInt(flags["end-seq"]),
        query: flagString(flags, "query"),
        includeTools: Boolean(flags.tools),
        includeThinking: Boolean(flags.thinking),
        artifactName: flagString(flags, "artifact"),
        startLine: parseOptionalInt(flags["start-line"]),
        endLine: parseOptionalInt(flags["end-line"]),
        maxChars: parseOptionalInt(flags["max-chars"]),
      },
      dataDirOpt,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "note-save") {
    const tagsRaw = flagString(flags, "tags");
    const { text, isError } = executeToolResult(
      "save_note",
      {
        topic: flagString(flags, "topic") || positional[1] || "",
        content: flagString(flags, "content") || positional.slice(2).join(" ") || "",
        workspace: flagString(flags, "workspace"),
        tags: tagsRaw ? tagsRaw.split(",") : [],
        id: flagString(flags, "id"),
        deleteId: flagString(flags, "delete"),
      },
      dataDirOpt,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "note-recall") {
    const { text, isError } = executeToolResult(
      "recall_notes",
      {
        query: positional.slice(1).join(" ") || flagString(flags, "query"),
        workspace: flagString(flags, "workspace"),
        tag: flagString(flags, "tag"),
        limit: parseOptionalInt(flags.limit),
      },
      dataDirOpt,
    );
    process.stdout.write(`${text}\n`);
    if (isError) process.exitCode = 1;
    return;
  }

  if (sub === "stats" || sub === "benchmark") {
    const report = analyzeMemoryUsage({
      ...dataDirOpt,
      recent: parseOptionalInt(flags.recent) || 50,
      includeChildren: Boolean(flags["include-children"]),
    });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatMemoryUsageMarkdown(report)}\n`);
    }
    return;
  }

  process.stdout.write(
    [
      `agy-memory v${SERVER_INFO.version} CLI usage:`,
      "  node dist/mcp-server.mjs --cli list [--source agy|codex|claude|all] [--workspace <dir>] [--min-steps 5] [--exclude <id>] [--limit 15] [query]",
      "  node dist/mcp-server.mjs --cli search [--mode text|file_history|error_history] [--source agy|codex|claude|all] [--scope all|user|assistant|artifacts|swarm] [--session <id>] [--exclude <id>] [--workspace <dir>] <query>",
      "  node dist/mcp-server.mjs --cli read <sessionId> [--source agy|codex|claude|all] [--mode digest|turns|artifacts|swarm] [--tail 20] [--start-seq N] [--end-seq N] [--query <q>] [--char-offset N]",
      "  node dist/mcp-server.mjs --cli note-save --topic <title> --content <text> [--workspace <dir>] [--tags a,b]",
      "  node dist/mcp-server.mjs --cli note-recall [query] [--workspace <dir>] [--tag <tag>]",
      "  node dist/mcp-server.mjs --cli stats [--recent 50] [--json]",
    ].join("\n") + "\n",
  );
}

const cliFlagIdx = process.argv.indexOf("--cli");
if (cliFlagIdx >= 0) {
  runCliMode(process.argv.slice(cliFlagIdx + 1));
} else {
  runMcpStdioServer();
}
