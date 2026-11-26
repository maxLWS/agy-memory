import fs from "node:fs";
import path from "node:path";
import { loadSessionCatalog, resolveDataDir } from "./store.js";
import type {
  FinalizedMemoryUsageBucket,
  MemoryToolCallCounts,
  MemoryUsageBucket,
  MemoryUsageReport,
} from "./types.js";

const AGY_MEMORY_TOOL_RE = /^(?:mcp_)?agy-memory_memory_([a-z_]+)$/;
const RAW_BRAIN_SHELL_RE = /(?:\.gemini[\\/]+antigravity(?:-cli)?[\\/]+brain|conversation_summaries\.db|transcript(?:_full)?\.jsonl|board\.jsonl)/i;

function parseArgsObj(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(raw)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function emptyBucket(): MemoryUsageBucket {
  return {
    sessions: 0,
    sessionsWithSnapshot: 0,
    sessionsWithMemoryTools: 0,
    llmTurns: 0,
    totalToolCalls: 0,
    memoryToolCalls: {
      list_sessions: 0,
      search_sessions: 0,
      read_session: 0,
      save_note: 0,
      recall_notes: 0,
    },
    rawBrainReads: 0,
    mcpSpills: 0,
    budgetTruncations: 0,
    toolErrors: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
}

function isMemoryToolKey(key: string): key is keyof MemoryToolCallCounts {
  return (
    key === "list_sessions" ||
    key === "search_sessions" ||
    key === "read_session" ||
    key === "save_note" ||
    key === "recall_notes"
  );
}

function analyzeSingleTranscript(transcriptPath: string): MemoryUsageBucket | null {
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }

  const s = emptyBucket();
  s.sessions = 1;
  let hasSnapshot = false;
  let usedMemory = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step: Record<string, unknown>;
    try {
      step = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const content = typeof step.content === "string" ? step.content : "";
    if (content.includes("[agy-memory]")) {
      hasSnapshot = true;
    }

    if (step.type === "PLANNER_RESPONSE") {
      s.llmTurns += 1;
      s.uncachedInputTokens += Number(step.input_tokens || 0);
      s.cacheReadTokens += Number(step.cache_read_tokens || 0);
      s.outputTokens += Number(step.output_tokens || 0);
      const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Array<Record<string, unknown>>) : [];
      s.totalToolCalls += calls.length;

      for (const tc of calls) {
        const name = String(tc?.name || "");
        const args = parseArgsObj(tc?.arguments ?? tc?.args);
        const m = AGY_MEMORY_TOOL_RE.exec(name);
        if (m && m[1]) {
          usedMemory = true;
          if (isMemoryToolKey(m[1])) {
            s.memoryToolCalls[m[1]] += 1;
          }
          continue;
        }
        if (name === "run_command") {
          const cmd = String(args.CommandLine || args.command || "");
          if (RAW_BRAIN_SHELL_RE.test(cmd)) s.rawBrainReads += 1;
        } else if (name === "read_file") {
          const p = String(args.Path || args.path || "");
          if (RAW_BRAIN_SHELL_RE.test(p)) s.rawBrainReads += 1;
        }
      }
    } else if (step.type === "GENERIC") {
      if (content.includes("The tool's output was truncated due to being too long.")) {
        s.mcpSpills += 1;
      }
      if (content.includes("… [truncated")) {
        s.budgetTruncations += 1;
      }
      if (step.status === "ERROR" || /^Error:/m.test(content)) {
        s.toolErrors += 1;
      }
    }
  }

  if (hasSnapshot) s.sessionsWithSnapshot = 1;
  if (usedMemory) s.sessionsWithMemoryTools = 1;
  return s;
}

function mergeBucket(dst: MemoryUsageBucket, src: MemoryUsageBucket): void {
  dst.sessions += src.sessions;
  dst.sessionsWithSnapshot += src.sessionsWithSnapshot;
  dst.sessionsWithMemoryTools += src.sessionsWithMemoryTools;
  dst.llmTurns += src.llmTurns;
  dst.totalToolCalls += src.totalToolCalls;
  dst.memoryToolCalls.list_sessions += src.memoryToolCalls.list_sessions;
  dst.memoryToolCalls.search_sessions += src.memoryToolCalls.search_sessions;
  dst.memoryToolCalls.read_session += src.memoryToolCalls.read_session;
  dst.memoryToolCalls.save_note += src.memoryToolCalls.save_note;
  dst.memoryToolCalls.recall_notes += src.memoryToolCalls.recall_notes;
  dst.rawBrainReads += src.rawBrainReads;
  dst.mcpSpills += src.mcpSpills;
  dst.budgetTruncations += src.budgetTruncations;
  dst.toolErrors += src.toolErrors;
  dst.uncachedInputTokens += src.uncachedInputTokens;
  dst.cacheReadTokens += src.cacheReadTokens;
  dst.outputTokens += src.outputTokens;
}

function finalizeBucket(b: MemoryUsageBucket): FinalizedMemoryUsageBucket {
  const memTotal =
    b.memoryToolCalls.list_sessions +
    b.memoryToolCalls.search_sessions +
    b.memoryToolCalls.read_session +
    b.memoryToolCalls.save_note +
    b.memoryToolCalls.recall_notes;
  const estBillableEquiv = Math.round(b.uncachedInputTokens + 0.1 * b.cacheReadTokens + 5 * b.outputTokens);
  const avgTurns = b.sessions > 0 ? Number((b.llmTurns / b.sessions).toFixed(2)) : 0;
  return {
    ...b,
    memoryToolCallsTotal: memTotal,
    avgTurnsPerSession: avgTurns,
    estBillableEquiv,
  };
}

export interface AnalyzeUsageOptions {
  dataDir?: string;
  recent?: number;
  includeChildren?: boolean;
}

export function analyzeMemoryUsage(opts: AnalyzeUsageOptions = {}): MemoryUsageReport {
  const { dataDir = resolveDataDir(), recent = 50, includeChildren = false } = opts;
  const catalog = loadSessionCatalog(dataDir).filter(
    (entry) => entry.hasTranscript && (includeChildren || !entry.isChild),
  );
  const limit = Math.max(1, Math.min(500, Number(recent) || 50));
  const selected = catalog.slice(0, limit);

  const overall = emptyBucket();
  const withMemory = emptyBucket();
  const withoutMemory = emptyBucket();

  for (const entry of selected) {
    const stat = analyzeSingleTranscript(entry.paths.transcriptPath);
    if (!stat) continue;
    mergeBucket(overall, stat);
    if (stat.sessionsWithMemoryTools > 0 || stat.sessionsWithSnapshot > 0) {
      mergeBucket(withMemory, stat);
    } else {
      mergeBucket(withoutMemory, stat);
    }
  }

  return {
    dataDir: path.resolve(dataDir),
    analyzedLimit: limit,
    overall: finalizeBucket(overall),
    withAgyMemory: finalizeBucket(withMemory),
    withoutAgyMemory: finalizeBucket(withoutMemory),
  };
}

export function formatMemoryUsageMarkdown(report: MemoryUsageReport): string {
  const { overall: o, withAgyMemory: w, withoutAgyMemory: wo } = report;
  const tc = o.memoryToolCalls;
  const rows = [
    "# agy-memory Offline Transcript Analytics",
    "",
    `- Data dir: \`${report.dataDir}\``,
    `- Recent root sessions analyzed: ${o.sessions} (limit ${report.analyzedLimit})`,
    "",
    "| Metric | Overall | Without agy-memory | With agy-memory |",
    "| :--- | ---: | ---: | ---: |",
    `| Sessions | ${o.sessions} | ${wo.sessions} | ${w.sessions} |`,
    `| Sessions with snapshot | ${o.sessionsWithSnapshot} | 0 | ${w.sessionsWithSnapshot} |`,
    `| Sessions calling agy-memory tools | ${o.sessionsWithMemoryTools} | 0 | ${w.sessionsWithMemoryTools} |`,
    `| LLM turns (avg/session) | ${o.llmTurns} (${o.avgTurnsPerSession}) | ${wo.llmTurns} (${wo.avgTurnsPerSession}) | ${w.llmTurns} (${w.avgTurnsPerSession}) |`,
    `| Total tool calls | ${o.totalToolCalls} | ${wo.totalToolCalls} | ${w.totalToolCalls} |`,
    `| agy-memory calls | ${o.memoryToolCallsTotal} (list:${tc.list_sessions}, search:${tc.search_sessions}, read:${tc.read_session}, save:${tc.save_note}, recall:${tc.recall_notes}) | 0 | ${w.memoryToolCallsTotal} |`,
    `| Raw brain transcript shell/read calls | ${o.rawBrainReads} | ${wo.rawBrainReads} | ${w.rawBrainReads} |`,
    `| Disk spills / budget truncs / errors | ${o.mcpSpills} / ${o.budgetTruncations} / ${o.toolErrors} | ${wo.mcpSpills} / ${wo.budgetTruncations} / ${wo.toolErrors} | ${w.mcpSpills} / ${w.budgetTruncations} / ${w.toolErrors} |`,
    `| Est. billable equiv tokens | ${o.estBillableEquiv.toLocaleString("en-US")} | ${wo.estBillableEquiv.toLocaleString("en-US")} | ${w.estBillableEquiv.toLocaleString("en-US")} |`,
  ];
  return rows.join("\n");
}
