import fs from "node:fs";
import path from "node:path";
import {
  cleanUserRequestText,
  formatRelativeTime,
  formatShortDate,
  formatWorkspaceLabel,
  parseAgyTimestamp,
  parseQueryTokens,
  truncateUtf8,
} from "./store.js";
import {
  checkScanBudget,
  createScanBudget,
  resolveToolPath,
  streamJsonlFromOffset,
} from "./stream.js";
import type {
  FileActionOutcome,
  ScanBudget,
  SessionEntry,
  SessionTraceDoc,
  ToolResult,
  TraceErrorEvent,
  TraceFileEvent,
  TracePassEvent,
} from "./types.js";

const MAX_TRACE_CACHE = 48;
const IS_WIN = process.platform === "win32";

const SINGLE_WRITE_TOOLS = new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file",
]);

const SINGLE_READ_TOOLS = new Set(["read_file", "view_file"]);

interface PendingToolCall {
  stepIndex: number;
  date: string;
  name: string;
  args: Record<string, unknown>;
}

interface AgyTraceState {
  doc: SessionTraceDoc;
  lastUser: string;
  lastAssistant: string;
  pendingBatch: PendingToolCall[];
}

interface AgyTraceCacheEntry {
  offset: number;
  eof: boolean;
  mtimeMs: number;
  size: number;
  state: AgyTraceState;
}

const agyTraceCache = new Map<string, AgyTraceCacheEntry>();

export function clearTraceCaches(): void {
  agyTraceCache.clear();
}

function lruPutTrace(key: string, val: AgyTraceCacheEntry): void {
  if (agyTraceCache.has(key)) agyTraceCache.delete(key);
  agyTraceCache.set(key, val);
  while (agyTraceCache.size > MAX_TRACE_CACHE) {
    const first = agyTraceCache.keys().next().value;
    if (first === undefined) break;
    agyTraceCache.delete(first);
  }
}

function unwrapArgValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}

function parseArgsRecord(raw: unknown): Record<string, unknown> {
  let obj: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = unwrapArgValue(v);
  }
  return out;
}

function extractFileToolPaths(toolName: string, args: Record<string, unknown>): Array<{ path: string; isWrite: boolean }> {
  const low = toolName.toLowerCase();
  const out: Array<{ path: string; isWrite: boolean }> = [];
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";

  const pushPath = (raw: unknown, isWrite: boolean) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const val = raw.trim();
    const joined =
      cwd && !path.isAbsolute(val) && !/^[a-zA-Z]:[\\/]/.test(val)
        ? path.posix.join(cwd.replace(/\\/g, "/"), val)
        : val;
    out.push({ path: joined, isWrite });
  };

  if (SINGLE_WRITE_TOOLS.has(low)) {
    pushPath(args.Path ?? args.TargetFile ?? args.path, true);
    return out;
  }
  if (low === "apply_edits" || low.endsWith("_apply_edits")) {
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (e && typeof e === "object") pushPath((e as Record<string, unknown>).path, true);
      }
    }
    return out;
  }
  if (SINGLE_READ_TOOLS.has(low)) {
    pushPath(args.Path ?? args.AbsolutePath ?? args.path, false);
    return out;
  }
  if (low === "quick_outline" || low.endsWith("_quick_outline")) {
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) pushPath(p, false);
    }
    return out;
  }
  if (low === "read_slices" || low.endsWith("_read_slices")) {
    if (Array.isArray(args.outlines)) {
      for (const p of args.outlines) pushPath(p, false);
    }
    if (Array.isArray(args.slices)) {
      for (const s of args.slices) {
        if (s && typeof s === "object") pushPath((s as Record<string, unknown>).path, false);
      }
    }
    return out;
  }
  return out;
}

function stripTimestampHeader(text: string): string {
  return text
    .replace(/^(?:(?:Created At|Completed At):\s*[^\n]+\n?)+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyToolResponse(rawGeneric: string): boolean {
  if (!rawGeneric.trim()) return false;
  if (/^(?:Created At|Completed At):/i.test(rawGeneric)) return true;
  if (
    /^(?:Made \d+ replacement|Created file\.|Appended to file\.|Overwrote file\.|Showing lines |Command exited with code|The tool's output was truncated|Successfully |Encountered error in tool execution|Error:|Applied \d+ edit)/i.test(
      rawGeneric.trim(),
    )
  ) {
    return true;
  }
  if (/^<(?:SYSTEM_MESSAGE|USER_REQUEST|CONTEXT_SUMMARY)/i.test(rawGeneric.trim())) return false;
  return true;
}

function parseGenericOutcome(content: string): {
  status: "succeeded" | "failed" | "unverified";
  exitCode: number | null;
  snippet: string;
} {
  const cleaned = stripTimestampHeader(content);
  if (!cleaned) {
    return { status: "unverified", exitCode: null, snippet: "" };
  }

  const exitMatch = /Command exited with code\s*(-?\d+)/i.exec(cleaned);
  if (exitMatch) {
    const code = Number(exitMatch[1]);
    if (Number.isFinite(code) && code !== 0) {
      return { status: "failed", exitCode: code, snippet: cleaned.slice(0, 260) };
    }
    if (code === 0) {
      return { status: "succeeded", exitCode: 0, snippet: "" };
    }
  }

  if (
    /Encountered error in tool execution|Partial edit applied|\[FAIL\b|ERR_ASSERTION|\bTarget (?:string |text )?not found\b|\bFile already exists\b|\bPermission denied\b|^Error:/i.test(
      cleaned,
    )
  ) {
    return { status: "failed", exitCode: null, snippet: cleaned.slice(0, 260) };
  }

  if (
    /^(?:Made \d+ replacement|Created file\.|Appended to file\.|Overwrote file\.|Successfully (?:edited|wrote|created|applied)|Applied \d+ edit|Edited \d+ file|All \d+ edit|OK\b)/i.test(
      cleaned,
    ) ||
    /\b(?:applied|edited|created)\s+\d+\s+file/i.test(cleaned)
  ) {
    return { status: "succeeded", exitCode: null, snippet: "" };
  }

  return { status: "unverified", exitCode: null, snippet: "" };
}

function buildFullCommandKey(cmdLine: string, cwd: string): string {
  const compactCmd = String(cmdLine || "").replace(/\s+/g, " ").trim();
  const compactCwd = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
  return compactCwd ? `${compactCwd}::${compactCmd}` : compactCmd;
}

function pickMatchingPendingCall(batch: PendingToolCall[], cleanedOutput: string): PendingToolCall | undefined {
  if (batch.length === 0) return undefined;
  if (batch.length === 1) return batch.shift();

  const editPathMatch = /Made \d+ replacement(?:s)? in ([^\s]+)\s+starting at/i.exec(cleanedOutput);
  if (editPathMatch?.[1]) {
    const outPath = editPathMatch[1].replace(/\\/g, "/");
    const idx = batch.findIndex((c) => {
      const p = String(c.args.Path ?? c.args.TargetFile ?? c.args.path ?? "").replace(/\\/g, "/");
      return p && (p === outPath || outPath.endsWith(`/${p}`) || p.endsWith(`/${outPath}`));
    });
    if (idx >= 0) {
      return batch.splice(idx, 1)[0];
    }
  }
  return batch.shift();
}

export function extractSessionTraceDoc(entry: SessionEntry, budget?: ScanBudget): SessionTraceDoc {
  const filePath = entry.paths.transcriptPath;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (err) {
    if (budget) {
      budget.incomplete = true;
      budget.reason = `transcript stat error (${err instanceof Error ? err.message : "stat failed"})`;
    }
    return { fileEvents: [], errorEvents: [], passEvents: [] };
  }

  const cached = agyTraceCache.get(filePath);
  let state: AgyTraceState;
  let startOffset = 0;

  const canReuseExact = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
  const canResumeAppend = cached && cached.eof && cached.size < st.size;

  if (canReuseExact && cached.eof) {
    return cached.state.doc;
  }
  if (canReuseExact && !cached.eof) {
    state = cached.state;
    startOffset = cached.offset;
  } else if (canResumeAppend) {
    state = cached.state;
    startOffset = cached.offset;
  } else {
    state = {
      doc: { fileEvents: [], errorEvents: [], passEvents: [] },
      lastUser: "",
      lastAssistant: "",
      pendingBatch: [],
    };
  }

  const primaryWs = entry.workspaces[0] || "";
  const flushNextWithOutcome = (resultStepIndex: number, genericContent: string) => {
    if (state.pendingBatch.length === 0) return;
    if (!isLikelyToolResponse(genericContent)) return;

    const cleaned = stripTimestampHeader(genericContent);
    const call = pickMatchingPendingCall(state.pendingBatch, cleaned);
    if (!call) return;

    const outcome = parseGenericOutcome(genericContent);
    const pathHits = extractFileToolPaths(call.name, call.args);
    for (const ph of pathHits) {
      const norm = resolveToolPath(ph.path, primaryWs);
      if (!norm.resolvedPath) continue;
      if (norm.resolvedPath.includes("/.gemini/")) continue;
      const fileOutcome: FileActionOutcome = ph.isWrite
        ? outcome.status === "failed"
          ? "write_failed"
          : outcome.status === "succeeded"
            ? "write_succeeded"
            : "write_unverified"
        : "read";
      state.doc.fileEvents.push({
        stepIndex: call.stepIndex,
        date: call.date,
        toolName: call.name,
        rawPath: norm.rawPath,
        resolvedPath: norm.resolvedPath,
        basename: norm.basename,
        outcome: fileOutcome,
        userPrompt: state.lastUser.slice(0, 140),
        assistantSnippet: state.lastAssistant.slice(0, 180),
      });
    }

    const cmdLine = String(call.args.CommandLine || call.args.command || "").trim();
    const cmdCwd = String(call.args.Cwd || call.args.cwd || primaryWs || "").trim();
    const lowName = call.name.toLowerCase();
    const isCmd = lowName === "run_command" || lowName.endsWith("_run_checks");
    const invocation = cmdLine
      ? cmdLine.split(/\r?\n/)[0]!.slice(0, 160)
      : pathHits[0]
        ? `${call.name} ${pathHits[0].path}`
        : call.name;
    const cmdKey = cmdLine
      ? buildFullCommandKey(cmdLine, cmdCwd)
      : `${lowName}:${pathHits[0]?.path || ""}`;

    if (outcome.status === "failed") {
      state.doc.errorEvents.push({
        stepIndex: call.stepIndex,
        resultStepIndex,
        date: call.date,
        toolName: call.name,
        invocation,
        errorSnippet: outcome.snippet,
        exitCode: outcome.exitCode,
        commandKey: cmdKey,
        userPrompt: state.lastUser.slice(0, 140),
      });
    } else if (isCmd && outcome.status === "succeeded" && outcome.exitCode === 0) {
      state.doc.passEvents.push({
        stepIndex: call.stepIndex,
        date: call.date,
        toolName: call.name,
        invocation,
        commandKey: cmdKey,
      });
    }
  };

  const res = streamJsonlFromOffset(
    filePath,
    startOffset,
    (line) => {
      let step: {
        step_index?: unknown;
        type?: string;
        created_at?: string;
        content?: unknown;
        tool_calls?: Array<{ name?: string; arguments?: unknown; args?: unknown }>;
      };
      try {
        step = JSON.parse(line) as typeof step;
      } catch {
        return;
      }
      const stepIdx = typeof step.step_index === "number" ? step.step_index : -1;
      const date = formatShortDate(parseAgyTimestamp(step.created_at));

      if (step.type === "USER_INPUT") {
        state.pendingBatch.length = 0;
        const cleaned = cleanUserRequestText(typeof step.content === "string" ? step.content : "");
        if (cleaned) state.lastUser = cleaned.replace(/\s+/g, " ").trim();
        return;
      }

      if (step.type === "PLANNER_RESPONSE") {
        state.pendingBatch.length = 0;
        const txt = typeof step.content === "string" ? step.content.trim() : "";
        if (txt) {
          state.lastAssistant = txt.replace(/\s+/g, " ").trim();
          for (let i = state.doc.fileEvents.length - 1; i >= 0 && i >= state.doc.fileEvents.length - 8; i -= 1) {
            const ev = state.doc.fileEvents[i]!;
            if (!ev.assistantSnippet && ev.userPrompt === state.lastUser.slice(0, 140)) {
              ev.assistantSnippet = state.lastAssistant.slice(0, 180);
            }
          }
        }
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          for (const tc of step.tool_calls) {
            if (!tc?.name) continue;
            state.pendingBatch.push({
              stepIndex: stepIdx,
              date,
              name: tc.name,
              args: parseArgsRecord(tc.arguments ?? tc.args),
            });
          }
        }
        return;
      }

      if (step.type === "GENERIC") {
        const content = typeof step.content === "string" ? step.content : "";
        flushNextWithOutcome(stepIdx, content);
      }
    },
    budget,
  );

  if (!res.ioError) {
    lruPutTrace(filePath, {
      offset: res.newOffset,
      eof: res.eof,
      mtimeMs: res.mtimeMs,
      size: res.size,
      state,
    });
  }
  return state.doc;
}

export interface TraceSearchOptions {
  eligible: SessionEntry[];
  query: string;
  coverageLabel: string;
  maxSessions: number;
  maxChars: number;
  maxScanBytes?: number;
  maxScanMs?: number;
}

function normalizeForMatch(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return IS_WIN ? norm.toLowerCase() : norm;
}

function matchesTargetFile(ev: TraceFileEvent, queryNorm: string, isBasenameQuery: boolean): boolean {
  const resNorm = normalizeForMatch(ev.resolvedPath);
  const baseNorm = IS_WIN ? ev.basename.toLowerCase() : ev.basename;
  if (isBasenameQuery) {
    return baseNorm === queryNorm || resNorm.endsWith(`/${queryNorm}`);
  }
  return resNorm === queryNorm || resNorm.endsWith(`/${queryNorm}`);
}

export function runFileHistorySearch(opts: TraceSearchOptions): ToolResult {
  const { eligible, query, coverageLabel, maxSessions, maxChars } = opts;
  const cleanQuery = String(query || "").trim().replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (!cleanQuery) {
    return { text: "Error: query (file path or filename) is required for mode='file_history'.", isError: true };
  }

  const queryNorm = normalizeForMatch(cleanQuery);
  const isBasenameQuery = !queryNorm.includes("/");
  const budget: ScanBudget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();

  const hits: Array<{
    entry: SessionEntry;
    writes: TraceFileEvent[];
    failedWrites: TraceFileEvent[];
    unverifiedWrites: TraceFileEvent[];
    reads: TraceFileEvent[];
    resolvedPaths: Set<string>;
  }> = [];

  const distinctPaths = new Map<string, { sessions: Set<string>; writes: number; reads: number }>();

  for (const entry of eligible) {
    if (!checkScanBudget(budget)) break;
    budget.sessionsScanned += 1;
    const doc = extractSessionTraceDoc(entry, budget);
    const matched = doc.fileEvents.filter((ev) => matchesTargetFile(ev, queryNorm, isBasenameQuery));
    if (matched.length === 0) continue;

    const writes: TraceFileEvent[] = [];
    const failedWrites: TraceFileEvent[] = [];
    const unverifiedWrites: TraceFileEvent[] = [];
    const reads: TraceFileEvent[] = [];
    const resolvedPaths = new Set<string>();
    for (const ev of matched) {
      resolvedPaths.add(ev.resolvedPath);
      const stat = distinctPaths.get(ev.resolvedPath) || { sessions: new Set<string>(), writes: 0, reads: 0 };
      stat.sessions.add(entry.canonicalId);
      if (ev.outcome === "write_succeeded") {
        writes.push(ev);
        stat.writes += 1;
      } else if (ev.outcome === "write_failed") {
        failedWrites.push(ev);
      } else if (ev.outcome === "write_unverified") {
        unverifiedWrites.push(ev);
      } else {
        reads.push(ev);
        stat.reads += 1;
      }
      distinctPaths.set(ev.resolvedPath, stat);
    }
    hits.push({ entry, writes, failedWrites, unverifiedWrites, reads, resolvedPaths });
  }

  const coverageBanner = budget.incomplete
    ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${eligible.length} sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays — do NOT treat 0-match as authoritative).`
    : `Complete scan: ${budget.sessionsScanned}/${eligible.length} sessions (${coverageLabel}).`;

  if (hits.length === 0) {
    return {
      text: `No file tool history matched "${cleanQuery}".\n${coverageBanner}`,
      isError: false,
    };
  }

  hits.sort((a, b) => {
    const aRank = a.writes.length > 0 ? 2 : a.unverifiedWrites.length > 0 ? 1 : 0;
    const bRank = b.writes.length > 0 ? 2 : b.unverifiedWrites.length > 0 ? 1 : 0;
    if (bRank !== aRank) return bRank - aRank;
    return b.entry.updatedMs - a.entry.updatedMs;
  });

  const lines: string[] = [
    `File history for "${cleanQuery}" — ${hits.length} session(s) (showing top ${Math.min(hits.length, maxSessions)}):`,
    coverageBanner,
  ];

  if (isBasenameQuery && distinctPaths.size > 1) {
    lines.push(
      `\nDisambiguation: "${cleanQuery}" matched ${distinctPaths.size} distinct resolved paths (pass a relative/full path to narrow):`,
    );
    const rankedPaths = [...distinctPaths.entries()].sort(
      (a, b) => b[1].writes - a[1].writes || b[1].sessions.size - a[1].sessions.size,
    );
    for (const [rp, info] of rankedPaths.slice(0, 6)) {
      lines.push(`- ${rp} (${info.sessions.size} session(s), ${info.writes} write_succeeded, ${info.reads} read)`);
    }
  }

  for (const h of hits.slice(0, maxSessions)) {
    const e = h.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
    lines.push(
      `\n### ${e.shortId} — ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`,
    );
    lines.push(`ID: ${e.sessionId}`);
    lines.push(`Paths: ${[...h.resolvedPaths].slice(0, 3).join(", ")}`);
    const unvPart = h.unverifiedWrites.length > 0 ? `, ${h.unverifiedWrites.length} write_unverified` : "";
    lines.push(
      `Actions: ${h.writes.length} write_succeeded, ${h.failedWrites.length} write_failed${unvPart}, ${h.reads.length} read`,
    );
    const exemplar = h.writes[h.writes.length - 1] || h.unverifiedWrites[0] || h.failedWrites[0] || h.reads[0]!;
    const steps = [...new Set([...h.writes, ...h.unverifiedWrites, ...h.failedWrites].map((x) => `#${x.stepIndex}`))].slice(-6);
    if (steps.length > 0) {
      lines.push(
        `Write steps: ${steps.join(", ")} (use read_session(sessionId="${e.shortId}", mode="turns", startStep, endStep) for verbatim context)`,
      );
    } else {
      const rSteps = [...new Set(h.reads.map((x) => `#${x.stepIndex}`))].slice(-4);
      lines.push(`Read steps: ${rSteps.join(", ")}`);
    }
    if (exemplar.userPrompt) {
      lines.push(`- [user intent @#${exemplar.stepIndex}] ${exemplar.userPrompt}`);
    }
    if (exemplar.assistantSnippet) {
      lines.push(`- [turn summary] ${exemplar.assistantSnippet}`);
    }
  }

  return { text: truncateUtf8(lines.join("\n"), maxChars), isError: false };
}

export function runErrorHistorySearch(opts: TraceSearchOptions): ToolResult {
  const { eligible, query, coverageLabel, maxSessions, maxChars } = opts;
  const terms = parseQueryTokens(query);
  if (terms.length === 0) {
    return { text: "Error: query (error pattern or command keyword) is required for mode='error_history'.", isError: true };
  }

  const budget: ScanBudget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();

  const hits: Array<{
    entry: SessionEntry;
    items: Array<{
      err: TraceErrorEvent;
      subsequentWrites: TraceFileEvent[];
      matchingPass: TracePassEvent | null;
    }>;
  }> = [];

  for (const entry of eligible) {
    if (!checkScanBudget(budget)) break;
    budget.sessionsScanned += 1;
    const doc = extractSessionTraceDoc(entry, budget);
    if (doc.errorEvents.length === 0) continue;

    const matchedItems: Array<{
      err: TraceErrorEvent;
      subsequentWrites: TraceFileEvent[];
      matchingPass: TracePassEvent | null;
    }> = [];

    for (const err of doc.errorEvents) {
      const hay = `${err.toolName} ${err.invocation} ${err.errorSnippet} ${err.userPrompt}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;

      const subsequentWrites = doc.fileEvents
        .filter((f) => f.outcome === "write_succeeded" && f.stepIndex > err.stepIndex)
        .slice(0, 5);
      const matchingPass =
        doc.passEvents.find((p) => p.stepIndex > err.stepIndex && p.commandKey === err.commandKey) || null;
      matchedItems.push({ err, subsequentWrites, matchingPass });
    }

    if (matchedItems.length > 0) {
      hits.push({ entry, items: matchedItems.slice(-3) });
    }
  }

  const coverageBanner = budget.incomplete
    ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${eligible.length} sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays — do NOT treat 0-match as authoritative).`
    : `Complete scan: ${budget.sessionsScanned}/${eligible.length} sessions (${coverageLabel}).`;

  if (hits.length === 0) {
    return {
      text: `No failed tool/command history matched "${query}".\n${coverageBanner}`,
      isError: false,
    };
  }

  hits.sort((a, b) => b.entry.updatedMs - a.entry.updatedMs);

  const lines: string[] = [
    `Error history for "${query}" — ${hits.length} session(s) (showing top ${Math.min(hits.length, maxSessions)}):`,
    coverageBanner,
  ];

  for (const h of hits.slice(0, maxSessions)) {
    const e = h.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
    lines.push(
      `\n### ${e.shortId} — ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`,
    );
    lines.push(`ID: ${e.sessionId}`);
    for (const item of h.items) {
      const exitTag = item.err.exitCode !== null ? ` exit=${item.err.exitCode}` : "";
      lines.push(`- [failing invocation #${item.err.stepIndex}→#${item.err.resultStepIndex}${exitTag}] ${item.err.invocation}`);
      lines.push(`  Error: ${item.err.errorSnippet}`);
      if (item.subsequentWrites.length > 0) {
        const writeList = item.subsequentWrites.map((w) => `${w.rawPath} (#${w.stepIndex})`).join(", ");
        lines.push(`  Subsequent edits in session (candidate changes, not proven sole cause): ${writeList}`);
      } else {
        lines.push("  Subsequent edits in session: none observed");
      }
      if (item.matchingPass) {
        lines.push(`  Later matching rerun: PASSED at #${item.matchingPass.stepIndex} (${item.matchingPass.invocation})`);
      } else {
        lines.push("  Later matching rerun: UNRESOLVED (no exact matching exit-0 rerun observed in this session)");
      }
    }
  }

  return { text: truncateUtf8(lines.join("\n"), maxChars), isError: false };
}
