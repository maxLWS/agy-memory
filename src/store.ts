import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type {
  ArtifactInfo,
  AssistantResponseRecord,
  RawSummaryRow,
  SearchableArtifact,
  SearchableMessage,
  SearchableSessionDoc,
  SessionEntry,
  SessionPaths,
  SwarmBoardMessage,
  ThoughtRecord,
  ToolCallRecord,
  ToolResult,
  TranscriptTurn,
} from "./types.js";

const TAIL_PREVIEW_BYTES = 160 * 1024;
const TAIL_FALLBACK_BYTES = 1024 * 1024;
const SQLITE_CANDIDATES =
  process.platform === "win32"
    ? ["sqlite3", "sqlite3.exe"]
    : ["sqlite3", "/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"];
const PYTHON_INVOCATIONS: ReadonlyArray<{ bin: string; prefixArgs: string[] }> =
  process.platform === "win32"
    ? [
        { bin: "python", prefixArgs: [] },
        { bin: "python3", prefixArgs: [] },
        { bin: "py", prefixArgs: ["-3"] },
      ]
    : [
        { bin: "python3", prefixArgs: [] },
        { bin: "/usr/bin/python3", prefixArgs: [] },
        { bin: "python", prefixArgs: [] },
      ];
const TRUNCATION_SUFFIX = "\n… [truncated to fit inline budget]";
const MAX_TURN_CACHE_ENTRIES = 64;
const MAX_FULL_CACHE_ENTRIES = 32;
const MAX_DOC_CACHE_ENTRIES = 64;

export const VALID_READ_MODES = new Set(["digest", "turns", "artifacts", "swarm"]);

interface CatalogCacheEntry {
  sig: string;
  entries: SessionEntry[];
}

interface TurnsCacheEntry {
  sig: string;
  turns: TranscriptTurn[];
  hasTruncatedContent: boolean;
}

interface FullStepsCacheEntry {
  sig: string;
  stepMap: Map<number, string>;
}

interface SearchDocCacheEntry {
  sig: string;
  doc: SearchableSessionDoc;
}

const catalogCache = new Map<string, CatalogCacheEntry>();
const turnsCache = new Map<string, TurnsCacheEntry>();
const fullStepsCache = new Map<string, FullStepsCacheEntry>();
const searchDocCache = new Map<string, SearchDocCacheEntry>();

interface NodeSqliteStatement {
  all: () => Array<Record<string, unknown>>;
}

interface NodeSqliteDatabase {
  prepare: (sql: string) => NodeSqliteStatement;
  close: () => void;
}

type NodeSqliteCtor = new (location: string, options?: { readOnly?: boolean; open?: boolean }) => NodeSqliteDatabase;

let cachedNodeSqliteCtor: NodeSqliteCtor | null | undefined;

function getNodeSqliteCtor(): NodeSqliteCtor | null {
  if (cachedNodeSqliteCtor !== undefined) return cachedNodeSqliteCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as { DatabaseSync?: NodeSqliteCtor };
    cachedNodeSqliteCtor = typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    cachedNodeSqliteCtor = null;
  }
  return cachedNodeSqliteCtor;
}

export function clearStoreCaches(): void {
  catalogCache.clear();
  turnsCache.clear();
  fullStepsCache.clear();
  searchDocCache.clear();
}

function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function statSignature(filePath: string): string {
  try {
    const st = fs.statSync(filePath);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "missing";
  }
}

export function resolveDataDir(overrideDir = ""): string {
  if (overrideDir && String(overrideDir).trim()) {
    return path.resolve(String(overrideDir).trim());
  }
  const envDir = process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "";
  if (envDir.trim()) {
    return path.isAbsolute(envDir.trim())
      ? envDir.trim()
      : path.join(os.homedir(), ".gemini", envDir.trim());
  }
  const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
  if (fs.existsSync(cliDir)) return cliDir;
  const ideDir = path.join(os.homedir(), ".gemini", "antigravity");
  if (fs.existsSync(ideDir)) return ideDir;
  return cliDir;
}

export function clampMaxChars(
  rawVal: unknown,
  fallback = 8200,
  minVal = 200,
  maxVal = 8200,
): number {
  if (rawVal === undefined || rawVal === null || rawVal === "") return fallback;
  const num = Number(rawVal);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(minVal, Math.min(maxVal, Math.floor(num)));
}

export function parseAgyTimestamp(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e14 ? Math.floor(raw / 1e6) : raw;
  }
  const text = String(raw ?? "").trim();
  if (!text) return 0;
  // Normalize Go nanosecond timestamps: "2026-11-24 15:49:05.298126299+00:00"
  const normalized = text
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, "$1T$2")
    .replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

export function formatRelativeTime(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0) return "unknown";
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function formatShortDate(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function trimTrailingHighSurrogate(str: string): string {
  if (!str) return "";
  const lastCode = str.charCodeAt(str.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return str.slice(0, -1);
  }
  return str;
}

export function safeSliceChars(text: string, maxLen: number): string {
  const s = String(text || "");
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return trimTrailingHighSurrogate(s.slice(0, maxLen));
}

export function truncateUtf8(
  text: string,
  maxChars = 8200,
  maxBytes = 8650,
  customSuffix = TRUNCATION_SUFFIX,
): string {
  const raw = String(text || "");
  const suffix = String(customSuffix || TRUNCATION_SUFFIX);
  const suffixChars = suffix.length;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");

  const safeMaxChars = Math.max(
    suffixChars + 16,
    Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 8200,
  );
  const safeMaxBytes = Math.max(
    suffixBytes + 16,
    Number.isFinite(Number(maxBytes)) ? Math.floor(Number(maxBytes)) : 8650,
  );

  if (raw.length <= safeMaxChars && Buffer.byteLength(raw, "utf8") <= safeMaxBytes) {
    return raw;
  }

  const budgetChars = Math.max(0, safeMaxChars - suffixChars);
  const budgetBytes = Math.max(0, safeMaxBytes - suffixBytes);

  let out = trimTrailingHighSurrogate(raw.slice(0, budgetChars));
  if (Buffer.byteLength(out, "utf8") > budgetBytes) {
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = trimTrailingHighSurrogate(out.slice(0, mid));
      if (Buffer.byteLength(candidate, "utf8") <= budgetBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    out = trimTrailingHighSurrogate(out.slice(0, lo));
  }

  return `${out.trimEnd()}${suffix}`;
}

export function parseQueryTokens(rawQuery: string): string[] {
  const text = String(rawQuery || "").trim();
  if (!text) return [];
  const terms: string[] = [];
  const seen = new Set<string>();
  const tokenRe = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    let tok = "";
    if (match[1] !== undefined) {
      tok = match[1].trim();
    } else if (match[2] !== undefined) {
      tok = match[2].trim();
      // Ignore standalone quotes like `""`
      if (/^"+$/.test(tok)) tok = "";
    }
    const low = tok.toLowerCase();
    if (low && !seen.has(low)) {
      seen.add(low);
      terms.push(low);
    }
  }
  return terms;
}

export function cleanUserRequestText(raw: string): string {
  if (typeof raw !== "string" || !raw) return "";
  let text = raw;
  const openMatch = /<USER_REQUEST>\s*/i.exec(text);
  if (openMatch) {
    text = text.slice(openMatch.index + openMatch[0].length);
  }
  const closeIdx = text.search(/<\/USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>/i);
  if (closeIdx >= 0) {
    text = text.slice(0, closeIdx);
  }
  text = text.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "").trim();
  return text.replace(/\r\n/g, "\n").trim();
}

export function decodeWorkspaceUris(rawJson: string | string[] | null | undefined): string[] {
  if (!rawJson) return [];
  let list: unknown[] = [];
  if (Array.isArray(rawJson)) {
    list = rawJson;
  } else {
    try {
      const parsed = JSON.parse(String(rawJson)) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  }
  return list
    .map((u) => {
      const s = String(u ?? "").trim();
      if (!s) return "";
      if (s.startsWith("file://")) {
        let stripped = s.slice("file://".length);
        try {
          stripped = decodeURIComponent(stripped);
        } catch {
          // Keep raw stripped URI if percent-encoding is malformed
        }
        // Normalize Windows file:///C:/Users/... -> C:/Users/...
        return stripped.replace(/^\/([A-Za-z]:\/)/, "$1");
      }
      return s;
    })
    .filter(Boolean);
}

export function normalizeFsPath(rawPath: string): string {
  const trimmed = String(rawPath || "").trim();
  const normalized = trimmed
    .replace(/\\/g, "/")
    .replace(/^\/([a-zA-Z]:\/)/, "$1")
    .replace(/\/+$/, "")
    .toLowerCase();
  return normalized || (trimmed === "/" ? "/" : "");
}

export function isTempPath(rawPath: string): boolean {
  const norm = normalizeFsPath(rawPath);
  if (!norm) return false;
  if (norm === "/tmp" || norm.startsWith("/tmp/") || norm === "/private/tmp" || norm.startsWith("/private/tmp/")) {
    return true;
  }
  const osTmp = normalizeFsPath(os.tmpdir());
  if (osTmp && (norm === osTmp || norm.startsWith(`${osTmp}/`))) {
    return true;
  }
  return false;
}

export function formatWorkspaceLabel(rawPath: string): string {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "";
  if (isTempPath(trimmed)) return trimmed;
  const slashNorm = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return path.posix.basename(slashNorm) || trimmed;
}

export function workspaceMatches(workspaces: string[], filter: string): boolean {
  if (!filter) return true;
  const f = normalizeFsPath(filter);
  if (!f) return true;
  if (!Array.isArray(workspaces) || workspaces.length === 0) return false;
  const isAbsFilter = f.startsWith("/") || /^[a-z]:\//.test(f);
  return workspaces.some((ws) => {
    const norm = normalizeFsPath(ws);
    if (!norm) return false;
    if (norm === f) return true;
    if (isAbsFilter) {
      return norm.startsWith(`${f}/`);
    }
    const base = path.posix.basename(norm);
    return base === f || norm.endsWith(`/${f}`) || norm.includes(`/${f}/`);
  });
}

export function noteWorkspaceMatches(noteWorkspace: string, filterWorkspace: string): boolean {
  const fw = normalizeFsPath(filterWorkspace);
  if (!fw) return true;
  const nw = normalizeFsPath(noteWorkspace);
  // Global notes (no workspace) always apply
  if (!nw) return true;
  if (nw === fw) return true;
  const isAbsFilter = fw.startsWith("/") || /^[a-z]:\//.test(fw);
  if (isAbsFilter) {
    // Note for parent workspace applies in child, and note for child shows when querying parent
    return nw.startsWith(`${fw}/`) || fw.startsWith(`${nw}/`);
  }
  const base = path.posix.basename(nw);
  return base === fw || nw.endsWith(`/${fw}`) || nw.includes(`/${fw}/`);
}

export function parseSessionIdList(spec: string | string[] | null | undefined): string[] {
  if (!spec) return [];
  const rawItems = Array.isArray(spec) ? spec : String(spec).split(",");
  return rawItems
    .map((item) => String(item ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export function matchesSessionId(sessionId: string, filterSpec: string | string[]): boolean {
  const targets = parseSessionIdList(filterSpec);
  if (targets.length === 0) return false;
  const sid = String(sessionId || "").trim().toLowerCase();
  if (!sid) return false;
  return targets.some((target) => {
    if (sid === target) return true;
    if (target.length >= 4 && sid.startsWith(target)) return true;
    return false;
  });
}

function readTailUtf8(filePath: string, maxBytes: number): { text: string; totalSize: number } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return { text: "", totalSize: 0 };
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, totalSize: size };
  } catch {
    return { text: "", totalSize: 0 };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

export function getSessionPaths(dataDir: string, sessionId: string): SessionPaths {
  const brainDir = path.join(dataDir, "brain", sessionId);
  const systemDir = path.join(brainDir, ".system_generated");
  const logsDir = path.join(systemDir, "logs");
  const swarmDir = path.join(systemDir, "swarm");
  return {
    brainDir,
    systemDir,
    transcriptPath: path.join(logsDir, "transcript.jsonl"),
    transcriptFullPath: path.join(logsDir, "transcript_full.jsonl"),
    swarmDir,
    swarmMembersPath: path.join(swarmDir, "members.json"),
    swarmBoardPath: path.join(swarmDir, "board.jsonl"),
    swarmPlanPath: path.join(swarmDir, "plan.json"),
    subagentsDir: path.join(systemDir, "subagents"),
  };
}

export function listSessionArtifactFiles(
  brainDir: string,
  { includeMeta = true }: { includeMeta?: boolean } = {},
): ArtifactInfo[] {
  try {
    const names = fs
      .readdirSync(brainDir)
      .filter((name) => name.endsWith(".md") && !name.startsWith("."))
      .sort();
    return names.map((name) => {
      const filePath = path.join(brainDir, name);
      let updatedAt = 0;
      let size = 0;
      try {
        const st = fs.statSync(filePath);
        updatedAt = st.mtimeMs || 0;
        size = st.size || 0;
      } catch {
        // Ignore stat error
      }
      let summary = "";
      if (includeMeta) {
        const metaPath = `${filePath}.metadata.json`;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            summary?: unknown;
            Summary?: unknown;
          };
          summary = String(meta.summary || meta.Summary || "").trim();
        } catch {
          // Optional metadata
        }
      }
      return { name, path: filePath, summary, updatedAt, size };
    });
  } catch {
    return [];
  }
}

export function isBoilerplatePrompt(text: string): boolean {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (/^\/[a-z0-9_-]+(?:\s+\S+)?$/i.test(clean) && clean.length <= 24) return true;
  if (clean.length <= 12) {
    const low = clean.toLowerCase();
    if (
      /^(ok|okay|yes|no|go|continue|resume|proceed|done|thanks|thx|hi|hello|ping|test|继续|好的|好|行|嗯|收到|开始|确认|ok\s*继续|继续吧|全局安装)[.!。！?？\s]*$/i.test(
        low,
      )
    ) {
      return true;
    }
    if (clean.length <= 5) return true;
  }
  return false;
}

function extractUserPromptFromTailText(
  tailText: string,
  preferSubstantive: boolean,
): { best: string; fallbackLatest: string } {
  const lines = tailText.split("\n");
  let fallbackLatest = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line || !line.includes('"USER_INPUT"')) continue;
    try {
      const step = JSON.parse(line) as { type?: string; content?: string };
      if (step && step.type === "USER_INPUT") {
        const cleaned = cleanUserRequestText(step.content || "").replace(/\s+/g, " ").trim();
        if (!cleaned) continue;
        if (!fallbackLatest) fallbackLatest = cleaned;
        if (!preferSubstantive || !isBoilerplatePrompt(cleaned)) {
          return { best: cleaned, fallbackLatest };
        }
      }
    } catch {
      // Ignore malformed line
    }
  }
  return { best: "", fallbackLatest };
}

export function readLastUserPromptSnippet(
  transcriptPath: string,
  maxLen = 140,
  { preferSubstantive = false }: { preferSubstantive?: boolean } = {},
): string {
  // Use warm turns cache if already parsed and still valid
  const cached = turnsCache.get(transcriptPath);
  if (cached && cached.sig === statSignature(transcriptPath) && cached.turns.length > 0) {
    let fallbackLatest = "";
    for (let i = cached.turns.length - 1; i >= 0; i -= 1) {
      const turn = cached.turns[i]!;
      const cleaned = turn.userText.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      if (!fallbackLatest) fallbackLatest = cleaned;
      if (!preferSubstantive || !isBoilerplatePrompt(cleaned)) {
        return cleaned.length > maxLen ? `${safeSliceChars(cleaned, maxLen - 1)}…` : cleaned;
      }
    }
    if (fallbackLatest) {
      return fallbackLatest.length > maxLen ? `${safeSliceChars(fallbackLatest, maxLen - 1)}…` : fallbackLatest;
    }
    return "";
  }

  const first = readTailUtf8(transcriptPath, TAIL_PREVIEW_BYTES);
  if (!first.text) return "";
  let { best, fallbackLatest } = extractUserPromptFromTailText(first.text, preferSubstantive);

  if (!best && first.totalSize > TAIL_PREVIEW_BYTES) {
    const larger = readTailUtf8(transcriptPath, TAIL_FALLBACK_BYTES);
    if (larger.text) {
      const second = extractUserPromptFromTailText(larger.text, preferSubstantive);
      if (second.best) best = second.best;
      if (!fallbackLatest && second.fallbackLatest) fallbackLatest = second.fallbackLatest;
    }
  }

  // If file is larger than 1 MB and still no prompt found in tail (very long tool tail), scan turns once
  if (!best && !fallbackLatest && first.totalSize > TAIL_FALLBACK_BYTES) {
    const turns = parseTranscriptTurns(transcriptPath);
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const cleaned = turns[i]!.userText.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      if (!fallbackLatest) fallbackLatest = cleaned;
      if (!preferSubstantive || !isBoilerplatePrompt(cleaned)) {
        best = cleaned;
        break;
      }
    }
  }

  const chosen = best || fallbackLatest;
  if (!chosen) return "";
  return chosen.length > maxLen ? `${safeSliceChars(chosen, maxLen - 1)}…` : chosen;
}

const SUMMARY_SELECT_SQL = [
  "SELECT conversation_id, title, preview, step_count, last_modified_time,",
  "workspace_uris, status, parent_conversation_id, nesting_depth, last_user_input_time",
  "FROM conversation_summaries",
  "ORDER BY last_modified_time DESC",
].join(" ");

function mapDbRow(r: Record<string, unknown>): RawSummaryRow {
  return {
    conversationId: String(r.conversation_id ?? ""),
    title: String(r.title ?? ""),
    preview: String(r.preview ?? ""),
    stepCount: Number(r.step_count ?? 0),
    lastModifiedTime: String(r.last_modified_time ?? ""),
    workspaceUris: typeof r.workspace_uris === "string" ? r.workspace_uris : "[]",
    status: String(r.status ?? ""),
    parentConversationId: String(r.parent_conversation_id ?? ""),
    nestingDepth: Number(r.nesting_depth ?? 0),
    lastUserInputTime: String(r.last_user_input_time ?? ""),
  };
}

function querySummariesViaNodeSqlite(dbPath: string): RawSummaryRow[] | null {
  const DatabaseSync = getNodeSqliteCtor();
  if (!DatabaseSync) return null;
  let db: NodeSqliteDatabase | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(SUMMARY_SELECT_SQL).all();
    return Array.isArray(rows) ? rows.map(mapDbRow) : null;
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
    }
  }
}

function querySummariesViaSqliteCli(dbPath: string): RawSummaryRow[] | null {
  const sql = `${SUMMARY_SELECT_SQL};`;
  for (const sqliteBin of SQLITE_CANDIDATES) {
    try {
      const stdout = execFileSync(sqliteBin, ["-readonly", "-json", dbPath, sql], {
        encoding: "utf8",
        timeout: 2500,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = String(stdout || "").trim();
      if (!trimmed) return [];
      const rows = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(rows)) continue;
      return (rows as Array<Record<string, unknown>>).map(mapDbRow);
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function querySummariesViaPython(dbPath: string): RawSummaryRow[] | null {
  // Use pathlib.Path.as_uri() so read-only SQLite URIs work reliably on Windows, macOS, and Linux
  const pyScript = `
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=1.0)
rows = con.execute("""
  SELECT conversation_id, title, preview, step_count, last_modified_time,
         workspace_uris, status, parent_conversation_id, nesting_depth,
         last_user_input_time
  FROM conversation_summaries
  ORDER BY last_modified_time DESC
""").fetchall()
out = []
for r in rows:
  out.append({
    "conversationId": r[0] or "",
    "title": r[1] or "",
    "preview": r[2] or "",
    "stepCount": int(r[3] or 0),
    "lastModifiedTime": r[4] or "",
    "workspaceUris": r[5] or "[]",
    "status": r[6] or "",
    "parentConversationId": r[7] or "",
    "nestingDepth": int(r[8] or 0),
    "lastUserInputTime": r[9] or "",
  })
print(json.dumps(out))
`;
  for (const inv of PYTHON_INVOCATIONS) {
    try {
      const stdout = execFileSync(inv.bin, [...inv.prefixArgs, "-c", pyScript, dbPath], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(stdout) as unknown;
      if (Array.isArray(parsed)) return parsed as RawSummaryRow[];
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function scanBrainDirsFallback(dataDir: string): RawSummaryRow[] {
  const brainRoot = path.join(dataDir, "brain");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(brainRoot);
  } catch {
    return [];
  }

  const childIds = new Set<string>();
  for (const id of dirs) {
    const p = getSessionPaths(dataDir, id);
    try {
      const subFiles = fs.readdirSync(p.subagentsDir).filter((f) => f.endsWith(".json"));
      for (const f of subFiles) childIds.add(f.replace(/\.json$/, ""));
    } catch {
      // Ignore
    }
    try {
      const members = JSON.parse(fs.readFileSync(p.swarmMembersPath, "utf8")) as {
        members?: Record<string, { conversation_id?: string }>;
      };
      for (const m of Object.values(members?.members || {})) {
        if (m?.conversation_id && m.conversation_id !== id) {
          childIds.add(m.conversation_id);
        }
      }
    } catch {
      // Ignore
    }
  }

  const out: RawSummaryRow[] = [];
  for (const id of dirs) {
    if (id.startsWith(".")) continue;
    const p = getSessionPaths(dataDir, id);
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(p.transcriptPath);
    } catch {
      try {
        st = fs.statSync(p.brainDir);
      } catch {
        continue;
      }
    }
    out.push({
      conversationId: id,
      title: "",
      preview: "",
      stepCount: 0,
      lastModifiedTime: new Date(st.mtimeMs).toISOString(),
      workspaceUris: "[]",
      status: "",
      parentConversationId: childIds.has(id) ? "inferred" : "",
      nestingDepth: childIds.has(id) ? 1 : 0,
      lastUserInputTime: "",
    });
  }
  out.sort((a, b) => parseAgyTimestamp(b.lastModifiedTime) - parseAgyTimestamp(a.lastModifiedTime));
  return out;
}

function computeCatalogSignature(dataDir: string): string {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const walPath = `${dbPath}-wal`;
  const brainRoot = path.join(dataDir, "brain");
  return `${statSignature(dbPath)}|${statSignature(walPath)}|${statSignature(brainRoot)}`;
}

export function loadSessionCatalog(dataDir = resolveDataDir()): SessionEntry[] {
  const resolvedDir = path.resolve(dataDir);
  const sig = computeCatalogSignature(resolvedDir);
  const cached = catalogCache.get(resolvedDir);
  if (cached && cached.sig === sig) {
    // Re-check transcript/swarm existence only for entries that lacked them previously (cheap O(k))
    for (const entry of cached.entries) {
      if (!entry.hasTranscript && fs.existsSync(entry.paths.transcriptPath)) {
        entry.hasTranscript = true;
      }
      if (
        !entry.hasSwarm &&
        (fs.existsSync(entry.paths.swarmMembersPath) || fs.existsSync(entry.paths.swarmBoardPath))
      ) {
        entry.hasSwarm = true;
      }
    }
    return cached.entries;
  }

  const dbPath = path.join(resolvedDir, "conversation_summaries.db");
  let rawRows: RawSummaryRow[] | null = null;
  if (fs.existsSync(dbPath)) {
    rawRows = querySummariesViaNodeSqlite(dbPath);
    if (!Array.isArray(rawRows)) {
      rawRows = querySummariesViaSqliteCli(dbPath);
    }
    if (!Array.isArray(rawRows)) {
      rawRows = querySummariesViaPython(dbPath);
    }
  }
  if (!Array.isArray(rawRows)) {
    rawRows = scanBrainDirsFallback(resolvedDir);
  }

  // Also index brain dirs that exist on disk but aren't in summaries DB yet
  const seen = new Set(rawRows.map((r) => r.conversationId));
  const brainRoot = path.join(resolvedDir, "brain");
  try {
    for (const id of fs.readdirSync(brainRoot)) {
      if (id.startsWith(".") || seen.has(id)) continue;
      const p = getSessionPaths(resolvedDir, id);
      if (!fs.existsSync(p.transcriptPath)) continue;
      const st = fs.statSync(p.transcriptPath);
      rawRows.push({
        conversationId: id,
        title: "",
        preview: "",
        stepCount: 0,
        lastModifiedTime: new Date(st.mtimeMs).toISOString(),
        workspaceUris: "[]",
        status: "",
        parentConversationId: "",
        nestingDepth: 0,
        lastUserInputTime: "",
      });
    }
  } catch {
    // Ignore
  }

  const entries: SessionEntry[] = rawRows
    .map((row) => {
      const paths = getSessionPaths(resolvedDir, row.conversationId);
      const workspaces = decodeWorkspaceUris(row.workspaceUris);
      const updatedMs = Math.max(
        parseAgyTimestamp(row.lastModifiedTime),
        parseAgyTimestamp(row.lastUserInputTime),
      );
      const hasTranscript = fs.existsSync(paths.transcriptPath);
      const hasSwarm = fs.existsSync(paths.swarmMembersPath) || fs.existsSync(paths.swarmBoardPath);
      const isChild = Boolean(row.parentConversationId) || (row.nestingDepth || 0) > 0;
      return {
        sessionId: row.conversationId,
        shortId: row.conversationId.slice(0, 8),
        title: String(row.title || "").trim(),
        preview: String(row.preview || "").trim(),
        stepCount: Number(row.stepCount) || 0,
        updatedMs,
        workspaces,
        status: String(row.status || ""),
        isChild,
        parentConversationId: String(row.parentConversationId || ""),
        hasTranscript,
        hasSwarm,
        paths,
      };
    })
    .sort((a, b) => b.updatedMs - a.updatedMs);

  catalogCache.set(resolvedDir, { sig, entries });
  return entries;
}

export function resolveSessionEntry(
  dataDir: string,
  sessionRef: string,
  catalog: SessionEntry[] | null = null,
): { entry: SessionEntry | null; error: string | null } {
  const ref = String(sessionRef || "").trim().toLowerCase();
  if (!ref) return { entry: null, error: "sessionId is required." };
  const list = catalog || loadSessionCatalog(dataDir);
  const exact = list.find((s) => s.sessionId.toLowerCase() === ref);
  if (exact) return { entry: exact, error: null };
  if (ref.length < 4) {
    return { entry: null, error: `Session prefix "${sessionRef}" is too short (use at least 4 characters).` };
  }
  const matches = list.filter((s) => s.sessionId.toLowerCase().startsWith(ref));
  if (matches.length === 1) return { entry: matches[0]!, error: null };
  if (matches.length > 1) {
    const listStr = matches
      .slice(0, 5)
      .map((m) => `${m.shortId} (${m.title || "untitled"})`)
      .join(", ");
    return { entry: null, error: `Ambiguous session prefix "${sessionRef}"; matches: ${listStr}` };
  }
  return { entry: null, error: `No local conversation found matching "${sessionRef}".` };
}

function loadFullTranscriptStepMap(transcriptFullPath: string): Map<number, string> | null {
  if (!transcriptFullPath || !fs.existsSync(transcriptFullPath)) return null;
  const sig = statSignature(transcriptFullPath);
  const cached = fullStepsCache.get(transcriptFullPath);
  if (cached && cached.sig === sig) {
    return cached.stepMap;
  }

  let raw = "";
  try {
    raw = fs.readFileSync(transcriptFullPath, "utf8");
  } catch {
    return null;
  }

  const stepMap = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Fast pre-filter skips ~95% of GENERIC tool output lines before JSON.parse
    if (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('"PLANNER_RESPONSE"')) continue;
    let step: { step_index?: unknown; type?: string; content?: unknown };
    try {
      step = JSON.parse(trimmed) as { step_index?: unknown; type?: string; content?: unknown };
    } catch {
      continue;
    }
    if (typeof step.step_index !== "number") continue;
    if (step.type === "USER_INPUT") {
      const cleaned = cleanUserRequestText(typeof step.content === "string" ? step.content : "");
      if (cleaned) stepMap.set(step.step_index, cleaned);
    } else if (step.type === "PLANNER_RESPONSE") {
      const text = typeof step.content === "string" ? step.content.trim() : "";
      if (text) stepMap.set(step.step_index, text);
    }
  }

  lruSet(fullStepsCache, transcriptFullPath, { sig, stepMap }, MAX_FULL_CACHE_ENTRIES);
  return stepMap;
}

interface MutableTurn {
  turnIndex: number;
  startStep: number;
  endStep: number;
  createdAt: string;
  userStepIndex: number;
  userText: string;
  userContentTruncated: boolean;
  assistantResponses: AssistantResponseRecord[];
  tools: ToolCallRecord[];
  thoughts: ThoughtRecord[];
  models: Set<string>;
}

export function parseTranscriptTurns(
  transcriptPath: string,
  { hydrateFull = false, transcriptFullPath = "" }: { hydrateFull?: boolean; transcriptFullPath?: string } = {},
): TranscriptTurn[] {
  const sig = statSignature(transcriptPath);
  if (sig === "missing") return [];

  let baseEntry = turnsCache.get(transcriptPath);
  if (!baseEntry || baseEntry.sig !== sig) {
    let raw = "";
    try {
      raw = fs.readFileSync(transcriptPath, "utf8");
    } catch {
      return [];
    }

    const turns: MutableTurn[] = [];
    let currentTurn: MutableTurn | null = null;
    let hasTruncatedContent = false;

    const ensureTurn = (stepIndex: number, createdAt: string): MutableTurn => {
      if (!currentTurn) {
        currentTurn = {
          turnIndex: turns.length + 1,
          startStep: stepIndex,
          endStep: stepIndex,
          createdAt,
          userStepIndex: -1,
          userText: "",
          userContentTruncated: false,
          assistantResponses: [],
          tools: [],
          thoughts: [],
          models: new Set(),
        };
        turns.push(currentTurn);
      }
      return currentTurn;
    };

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Fast pre-filter: skips ~97% of raw lines (GENERIC tool responses / checkpoints)
      if (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('"PLANNER_RESPONSE"')) continue;
      let step: Record<string, unknown>;
      try {
        step = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const idx = typeof step.step_index === "number" ? step.step_index : -1;
      const createdAt = typeof step.created_at === "string" ? step.created_at : "";
      const contentTruncated =
        Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content");

      if (step.type === "USER_INPUT") {
        const cleaned = cleanUserRequestText(typeof step.content === "string" ? step.content : "");
        if (!cleaned) continue;
        if (contentTruncated) hasTruncatedContent = true;
        currentTurn = {
          turnIndex: turns.length + 1,
          startStep: idx,
          endStep: idx,
          createdAt,
          userStepIndex: idx,
          userText: cleaned,
          userContentTruncated: contentTruncated,
          assistantResponses: [],
          tools: [],
          thoughts: [],
          models: new Set(),
        };
        turns.push(currentTurn);
        continue;
      }

      if (step.type === "PLANNER_RESPONSE") {
        const turn = ensureTurn(idx, createdAt);
        turn.endStep = idx;
        if (step.model) turn.models.add(String(step.model));
        if (typeof step.thinking === "string" && step.thinking.trim()) {
          turn.thoughts.push({ stepIndex: idx, text: step.thinking.trim() });
        }
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          for (const tc of step.tool_calls as Array<{ name?: unknown }>) {
            if (tc?.name) turn.tools.push({ stepIndex: idx, name: String(tc.name) });
          }
        }
        if (typeof step.content === "string" && step.content.trim()) {
          if (contentTruncated) hasTruncatedContent = true;
          turn.assistantResponses.push({
            stepIndex: idx,
            createdAt,
            text: step.content.trim(),
            contentTruncated,
          });
        }
      }
    }

    const materialized: TranscriptTurn[] = turns.map((t) => {
      const lastResp = t.assistantResponses[t.assistantResponses.length - 1];
      return {
        ...t,
        models: [...t.models],
        finalAssistantText: lastResp ? lastResp.text : "",
        finalAssistantTruncated: lastResp ? Boolean(lastResp.contentTruncated) : false,
      };
    });

    baseEntry = { sig, turns: materialized, hasTruncatedContent };
    lruSet(turnsCache, transcriptPath, baseEntry, MAX_TURN_CACHE_ENTRIES);
  }

  if (!hydrateFull || !baseEntry.hasTruncatedContent || !transcriptFullPath) {
    return baseEntry.turns;
  }

  const fullMap = loadFullTranscriptStepMap(transcriptFullPath);
  if (!fullMap || fullMap.size === 0) {
    return baseEntry.turns;
  }

  return baseEntry.turns.map((t) => {
    const needsUser = t.userContentTruncated && fullMap.has(t.userStepIndex);
    const needsAssistant = t.assistantResponses.some((r) => r.contentTruncated && fullMap.has(r.stepIndex));
    if (!needsUser && !needsAssistant) return t;
    const hydratedUser = needsUser ? (fullMap.get(t.userStepIndex) ?? t.userText) : t.userText;
    const hydratedResponses = needsAssistant
      ? t.assistantResponses.map((r) =>
          r.contentTruncated && fullMap.has(r.stepIndex)
            ? { ...r, text: fullMap.get(r.stepIndex) ?? r.text, hydrated: true }
            : r,
        )
      : t.assistantResponses;
    const lastResp = hydratedResponses[hydratedResponses.length - 1];
    return {
      ...t,
      userText: hydratedUser,
      assistantResponses: hydratedResponses,
      finalAssistantText: lastResp ? lastResp.text : "",
      hydratedFromFull: true,
    };
  });
}

export function parseSwarmBoardMessages(swarmBoardPath: string): SwarmBoardMessage[] {
  if (!swarmBoardPath || !fs.existsSync(swarmBoardPath)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(swarmBoardPath, "utf8");
  } catch {
    return [];
  }
  const messages: SwarmBoardMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as {
        seq?: unknown;
        time?: unknown;
        agent?: unknown;
        kind?: unknown;
        text?: unknown;
      };
      messages.push({
        seq: typeof msg.seq === "number" ? msg.seq : messages.length + 1,
        time: String(msg.time ?? ""),
        agent: String(msg.agent ?? "?"),
        kind: String(msg.kind ?? ""),
        text: String(msg.text ?? "").trim(),
      });
    } catch {
      // Skip malformed line
    }
  }
  return messages;
}

export function extractSwarmBoardAgents(messages: SwarmBoardMessage[]): string[] {
  const agents = new Set<string>();
  for (const msg of messages) {
    if (msg.agent && msg.agent !== "?") agents.add(msg.agent);
    if (msg.kind === "brief") {
      const m = /^@([a-z0-9][a-z0-9_-]{0,24})\b/i.exec(msg.text);
      if (m && m[1] && m[1].toLowerCase() !== "all") agents.add(m[1]);
    }
  }
  return [...agents];
}

function splitFileLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function getSearchableSessionDoc(
  entry: SessionEntry,
  { includeFullTranscript = true }: { includeFullTranscript?: boolean } = {},
): SearchableSessionDoc {
  const cacheKey = `${entry.paths.brainDir}`;
  const transcriptSig = entry.hasTranscript ? statSignature(entry.paths.transcriptPath) : "none";
  const fullSig =
    includeFullTranscript && entry.hasTranscript && fs.existsSync(entry.paths.transcriptFullPath)
      ? statSignature(entry.paths.transcriptFullPath)
      : "none";
  const boardSig = entry.hasSwarm ? statSignature(entry.paths.swarmBoardPath) : "none";
  const artifactsMeta = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: false });
  const artSig = artifactsMeta.map((a) => `${a.name}:${Math.floor(a.updatedAt)}:${a.size}`).join(",");
  const combinedSig = `${transcriptSig}|${fullSig}|${boardSig}|${artSig}`;

  const cached = searchDocCache.get(cacheKey);
  if (cached && cached.sig === combinedSig) {
    return cached.doc;
  }

  const messages: SearchableMessage[] = [];
  let latestTranscriptMtimeMs = 0;
  let inFlightUserStepIndex = -1;

  if (entry.hasTranscript) {
    try {
      latestTranscriptMtimeMs = fs.statSync(entry.paths.transcriptPath).mtimeMs || 0;
    } catch {
      latestTranscriptMtimeMs = 0;
    }
    const turns = parseTranscriptTurns(entry.paths.transcriptPath, {
      hydrateFull: includeFullTranscript,
      transcriptFullPath: entry.paths.transcriptFullPath,
    });
    for (const turn of turns) {
      if (turn.userText) {
        messages.push({
          stepIndex: turn.userStepIndex >= 0 ? turn.userStepIndex : turn.startStep,
          role: "user",
          date: formatShortDate(parseAgyTimestamp(turn.createdAt)),
          text: turn.userText,
          lowText: turn.userText.toLowerCase(),
        });
      }
      for (const resp of turn.assistantResponses) {
        if (!resp.text) continue;
        messages.push({
          stepIndex: resp.stepIndex,
          role: "assistant",
          date: formatShortDate(parseAgyTimestamp(resp.createdAt)),
          text: resp.text,
          lowText: resp.text.toLowerCase(),
        });
      }
    }
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1]!;
      if (lastTurn.userText && lastTurn.assistantResponses.length === 0) {
        inFlightUserStepIndex = lastTurn.userStepIndex >= 0 ? lastTurn.userStepIndex : lastTurn.startStep;
      }
    }
  }

  const artifacts: SearchableArtifact[] = [];
  for (const art of artifactsMeta) {
    try {
      const content = fs.readFileSync(art.path, "utf8");
      const lineCount = splitFileLines(content).length;
      const combined = `${art.name}\n${content}`;
      artifacts.push({
        name: art.name,
        path: art.path,
        updatedAt: art.updatedAt,
        lineCount,
        content,
        lowCombined: combined.toLowerCase(),
      });
    } catch {
      // Ignore unreadable artifact
    }
  }

  const board = entry.hasSwarm
    ? parseSwarmBoardMessages(entry.paths.swarmBoardPath).map((msg) => ({
        ...msg,
        date: msg.time.slice(5, 16),
        lowText: `${msg.agent} ${msg.text}`.toLowerCase(),
      }))
    : [];

  const doc: SearchableSessionDoc = {
    messages,
    artifacts,
    board,
    latestTranscriptMtimeMs,
    inFlightUserStepIndex,
  };
  lruSet(searchDocCache, cacheKey, { sig: combinedSig, doc }, MAX_DOC_CACHE_ENTRIES);
  return doc;
}

export function isSessionDocCached(entry: SessionEntry): boolean {
  return searchDocCache.has(entry.paths.brainDir);
}

function summarizeToolCounts(tools: ToolCallRecord[], maxDistinct = 4): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const counts = new Map<string, number>();
  for (const tc of tools) {
    counts.set(tc.name, (counts.get(tc.name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, maxDistinct).map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  const extra = sorted.length > maxDistinct ? `, +${sorted.length - maxDistinct} more` : "";
  return `${shown.join(", ")}${extra}`;
}

export interface ListSessionsOptions {
  dataDir?: string;
  workspace?: string;
  query?: string;
  includeChildren?: boolean;
  excludeSessionId?: string;
  sinceHours?: number;
  minSteps?: number;
  limit?: number;
  maxChars?: number;
}

export function listSessionsResult(opts: ListSessionsOptions = {}): ToolResult {
  const {
    dataDir = resolveDataDir(),
    workspace = "",
    query = "",
    includeChildren = false,
    excludeSessionId = "",
    sinceHours = 0,
    minSteps = 0,
    limit = 15,
    maxChars = 8200,
  } = opts;

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const safeMinSteps = Math.max(0, Number(minSteps) || 0);
  const catalog = loadSessionCatalog(dataDir);
  const now = Date.now();
  const minMs = sinceHours > 0 ? now - sinceHours * 3600 * 1000 : 0;
  const queryTerms = parseQueryTokens(query);

  const filtered: Array<SessionEntry & { lastPrompt: string }> = [];
  for (const s of catalog) {
    if (!includeChildren && s.isChild) continue;
    if (excludeSessionId && matchesSessionId(s.sessionId, excludeSessionId)) continue;
    if (minMs > 0 && s.updatedMs < minMs) continue;
    if (safeMinSteps > 0 && s.stepCount < safeMinSteps) continue;
    if (!workspaceMatches(s.workspaces, workspace)) continue;

    let lastPrompt = "";
    if (queryTerms.length > 0) {
      const baseHay = `${s.title} ${s.preview} ${s.sessionId} ${s.workspaces.join(" ")}`.toLowerCase();
      let matched = queryTerms.every((t) => baseHay.includes(t));
      if (!matched && s.hasTranscript) {
        lastPrompt = readLastUserPromptSnippet(s.paths.transcriptPath, 160, { preferSubstantive: true });
        const extHay = `${baseHay} ${lastPrompt.toLowerCase()}`;
        matched = queryTerms.every((t) => extHay.includes(t));
      }
      if (!matched) continue;
    }

    filtered.push({ ...s, lastPrompt });
    if (filtered.length >= safeLimit) break;
  }

  if (filtered.length === 0) {
    return { text: `No matching conversations found in ${dataDir}.`, isError: false };
  }

  const lines = [
    `Recent conversations (${filtered.length} shown${workspace ? `, workspace~"${workspace}"` : ""}${safeMinSteps > 0 ? `, minSteps>=${safeMinSteps}` : ""}):`,
    "",
  ];
  for (const s of filtered) {
    const snippet =
      s.lastPrompt ||
      (s.hasTranscript ? readLastUserPromptSnippet(s.paths.transcriptPath, 120, { preferSubstantive: true }) : "");
    const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
    const wsName = s.workspaces.length > 0 ? (s.workspaces[0] ?? "") : "";
    const wsLabel = wsName ? formatWorkspaceLabel(wsName) : "";
    const badges: string[] = [];
    if (s.hasSwarm) badges.push("swarm");
    if (artifacts.length > 0) badges.push(`${artifacts.length} artifacts`);
    if (s.isChild) badges.push("child");
    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const title = s.title || "(untitled)";
    const meta = [
      formatShortDate(s.updatedMs),
      formatRelativeTime(s.updatedMs, now),
      wsLabel,
      s.stepCount > 0 ? `${s.stepCount} steps` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- **${s.shortId}** (${s.sessionId}) — ${title}${badgeStr}`);
    lines.push(`  ${meta}`);
    if (snippet) {
      lines.push(`  Last user: ${snippet}`);
    }
  }

  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

export function listSessionsFormatted(opts: ListSessionsOptions = {}): string {
  return listSessionsResult(opts).text;
}

function formatSwarmMode(
  entry: SessionEntry,
  {
    tailMessages = 20,
    startSeq = null,
    endSeq = null,
    query = "",
    safeMaxChars = 8200,
  }: {
    tailMessages?: number;
    startSeq?: number | null;
    endSeq?: number | null;
    query?: string;
    safeMaxChars?: number;
  },
): ToolResult {
  if (!entry.hasSwarm) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no Swarm data.`,
      isError: false,
    };
  }

  const headerLines = [`Swarm for ${entry.shortId} (${entry.title || "untitled"}):`];
  let membersLoaded = false;
  try {
    const membersObj = JSON.parse(fs.readFileSync(entry.paths.swarmMembersPath, "utf8")) as {
      title?: string;
      members?: Record<string, { role?: string; phase?: string; applied_model?: string; model?: string }>;
    };
    if (membersObj?.title) headerLines.push(`Title: ${membersObj.title}`);
    const roster = Object.entries(membersObj?.members || {}).map(
      ([name, info]) =>
        `${name} (${info.role || "worker"}, ${info.phase || "unknown"}${info.applied_model || info.model ? `, ${info.applied_model || info.model}` : ""})`,
    );
    if (roster.length > 0) {
      headerLines.push(`Members (${roster.length}): ${roster.join(" | ")}`);
      membersLoaded = true;
    }
  } catch {
    // Optional members.json
  }

  const allMessages = parseSwarmBoardMessages(entry.paths.swarmBoardPath);
  if (allMessages.length === 0) {
    headerLines.push("(No board.jsonl messages)");
    return { text: truncateUtf8(headerLines.join("\n"), safeMaxChars), isError: false };
  }

  const boardAgents = extractSwarmBoardAgents(allMessages);
  if (!membersLoaded && boardAgents.length > 0) {
    headerLines.push(`Board agents (${boardAgents.length}): ${boardAgents.join(", ")}`);
  }

  const queryTerms = parseQueryTokens(query);
  const hasStartSeq = typeof startSeq === "number" && Number.isFinite(startSeq);
  const hasEndSeq = typeof endSeq === "number" && Number.isFinite(endSeq);

  let matched = allMessages;
  if (hasStartSeq || hasEndSeq) {
    const sSeq = hasStartSeq ? startSeq : -Infinity;
    const eSeq = hasEndSeq ? endSeq : Infinity;
    matched = matched.filter((m) => m.seq >= sSeq && m.seq <= eSeq);
  }
  if (queryTerms.length > 0) {
    matched = matched.filter((m) => {
      const hay = `${m.agent} ${m.kind} ${m.text}`.toLowerCase();
      return queryTerms.every((t) => hay.includes(t));
    });
  }

  const firstAll = allMessages[0]!;
  const lastAll = allMessages[allMessages.length - 1]!;

  if (matched.length === 0) {
    headerLines.push(
      `No board messages matched filter (board range: #${firstAll.seq}-#${lastAll.seq}, ${allMessages.length} total messages).`,
    );
    return { text: truncateUtf8(headerLines.join("\n"), safeMaxChars), isError: false };
  }

  const limitMsgs = Math.max(1, Math.min(100, Number(tailMessages) || 20));
  const forwardFromStart = hasStartSeq && !hasEndSeq;
  const candidateSlice = forwardFromStart ? matched.slice(0, limitMsgs) : matched.slice(-limitMsgs);

  // Dynamic body clip: generous when viewing few targeted messages, tighter when scanning many
  const bodyClipLen = candidateSlice.length <= 4 ? 1400 : candidateSlice.length <= 12 ? 520 : 320;

  const formatMsgBlock = (msg: SwarmBoardMessage): string => {
    const body = msg.text;
    const clipped = body.length > bodyClipLen ? `${safeSliceChars(body, bodyClipLen - 1)}…` : body;
    return `\n[#${msg.seq} ${msg.time || ""} · ${msg.agent}${msg.kind ? ` (${msg.kind})` : ""}]\n${clipped}`;
  };

  const reserveForSummaryAndFooter = 240;
  const headerText = headerLines.join("\n");
  const maxBodyChars = Math.max(400, safeMaxChars - headerText.length - reserveForSummaryAndFooter);
  const maxBodyBytes = Math.max(400, 8650 - Buffer.byteLength(headerText, "utf8") - reserveForSummaryAndFooter);

  const chosen: Array<{ msg: SwarmBoardMessage; block: string }> = [];
  let usedChars = 0;
  let usedBytes = 0;

  if (forwardFromStart) {
    for (const msg of candidateSlice) {
      const block = formatMsgBlock(msg);
      const bBytes = Buffer.byteLength(block, "utf8");
      if (chosen.length > 0 && (usedChars + block.length > maxBodyChars || usedBytes + bBytes > maxBodyBytes)) {
        break;
      }
      chosen.push({ msg, block });
      usedChars += block.length;
      usedBytes += bBytes;
    }
  } else {
    // Pack from NEWEST backwards so newest messages are NEVER chopped off by truncation
    for (let i = candidateSlice.length - 1; i >= 0; i -= 1) {
      const msg = candidateSlice[i]!;
      const block = formatMsgBlock(msg);
      const bBytes = Buffer.byteLength(block, "utf8");
      if (chosen.length > 0 && (usedChars + block.length > maxBodyChars || usedBytes + bBytes > maxBodyBytes)) {
        break;
      }
      chosen.push({ msg, block });
      usedChars += block.length;
      usedBytes += bBytes;
    }
    chosen.reverse();
  }

  const firstShownSeq = chosen[0]!.msg.seq;
  const lastShownSeq = chosen[chosen.length - 1]!.msg.seq;
  const filterNote = queryTerms.length > 0 ? `, query="${query}"` : "";
  const orderNote = forwardFromStart ? "" : "; newest preserved";

  const out = [
    headerText,
    "",
    `Board messages (showing #${firstShownSeq}-#${lastShownSeq}, ${chosen.length} of ${matched.length} matching / ${allMessages.length} total${filterNote}${orderNote}):`,
  ];
  for (const item of chosen) {
    out.push(item.block);
  }
  if (chosen.length < allMessages.length) {
    out.push(
      `\nTip: board spans #${firstAll.seq}-#${lastAll.seq}. Pass startSeq/endSeq or query to inspect specific messages without truncation.`,
    );
  }

  return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
}

function formatArtifactsMode(
  entry: SessionEntry,
  artifacts: ArtifactInfo[],
  {
    artifactName = "",
    startLine = 1,
    endLine = 180,
    safeMaxChars = 8200,
  }: {
    artifactName?: string;
    startLine?: number;
    endLine?: number;
    safeMaxChars?: number;
  },
): ToolResult {
  if (artifacts.length === 0) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no Markdown artifacts.`,
      isError: false,
    };
  }

  if (!artifactName) {
    const out = [`Artifacts in ${entry.shortId} (${entry.title || "untitled"}):`];
    for (const a of artifacts) {
      let lineCount = 0;
      try {
        const content = fs.readFileSync(a.path, "utf8");
        lineCount = splitFileLines(content).length;
      } catch {
        // Ignore
      }
      out.push(`- ${a.name} (${lineCount} lines, ${a.size} B) — Path: ${a.path}`);
      if (a.summary) out.push(`  ${(a.summary.split("\n")[0] ?? "").slice(0, 180)}`);
    }
    out.push(
      "\nTip: For full reads of large Markdown artifacts (>100 lines), call built-in read_file(Path) directly (46 KB inline) or pass artifactName + startLine/endLine.",
    );
    return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
  }

  const target = artifacts.find(
    (a) =>
      a.name.toLowerCase() === artifactName.toLowerCase() ||
      a.name.toLowerCase().includes(artifactName.toLowerCase()),
  );
  if (!target) {
    return {
      text: `Error: Artifact "${artifactName}" not found in ${entry.shortId}. Available: ${artifacts.map((a) => a.name).join(", ")}`,
      isError: true,
    };
  }

  const allLines = splitFileLines(fs.readFileSync(target.path, "utf8"));
  const totalLines = allLines.length;
  const sLine = Math.max(1, Math.floor(Number(startLine) || 1));
  if (sLine > totalLines) {
    return {
      text: `Error: Artifact ${target.name} has only ${totalLines} lines (requested startLine=${sLine}). Path: ${target.path}`,
      isError: true,
    };
  }
  const requestedEnd =
    endLine !== undefined && endLine !== null && Number.isFinite(Number(endLine))
      ? Math.floor(Number(endLine))
      : sLine + 179;
  const eLine = Math.min(totalLines, Math.max(sLine, requestedEnd));

  // Pack lines within char/byte budget so header reports exact line range actually shown
  const headerReserve = 280 + target.path.length;
  const maxBodyChars = Math.max(200, safeMaxChars - headerReserve);
  const maxBodyBytes = Math.max(200, 8650 - headerReserve);

  const renderedLines: string[] = [];
  let usedChars = 0;
  let usedBytes = 0;
  let actualEndLine = sLine - 1;

  for (let lineNo = sLine; lineNo <= eLine; lineNo += 1) {
    const formatted = `${lineNo}: ${allLines[lineNo - 1] ?? ""}`;
    const addChars = formatted.length + 1;
    const addBytes = Buffer.byteLength(formatted, "utf8") + 1;
    if (renderedLines.length > 0 && (usedChars + addChars > maxBodyChars || usedBytes + addBytes > maxBodyBytes)) {
      break;
    }
    renderedLines.push(formatted);
    usedChars += addChars;
    usedBytes += addBytes;
    actualEndLine = lineNo;
  }

  const truncatedByBudget = actualEndLine < eLine;
  const header = `Artifact ${target.name} (${entry.shortId}, showing lines ${sLine}-${actualEndLine} of ${totalLines}${truncatedByBudget ? `; budget-truncated at line ${actualEndLine}` : ""}):\nPath: ${target.path}`;
  const footer =
    actualEndLine < totalLines
      ? `\n\n… [lines ${actualEndLine + 1}-${totalLines} not shown; use built-in read_file("${target.path}", StartLine=${actualEndLine + 1}, EndLine=${totalLines}) or startLine=${actualEndLine + 1}]`
      : "";

  return {
    text: truncateUtf8(`${header}\n\n${renderedLines.join("\n")}${footer}`, safeMaxChars),
    isError: false,
  };
}

export interface ReadSessionOptions {
  dataDir?: string;
  sessionId?: string;
  mode?: string;
  startStep?: number | null;
  endStep?: number | null;
  tailTurns?: number;
  includeTools?: boolean;
  includeThinking?: boolean;
  artifactName?: string;
  startLine?: number;
  endLine?: number;
  tailMessages?: number;
  startSeq?: number | null;
  endSeq?: number | null;
  query?: string;
  charOffset?: number;
  maxChars?: number;
}

export function readSessionResult(opts: ReadSessionOptions = {}): ToolResult {
  const {
    dataDir = resolveDataDir(),
    sessionId = "",
    mode = "digest",
    startStep = null,
    endStep = null,
    tailTurns = 6,
    includeTools = false,
    includeThinking = false,
    artifactName = "",
    startLine = 1,
    endLine = 180,
    tailMessages = 20,
    startSeq = null,
    endSeq = null,
    query = "",
    charOffset = 0,
    maxChars = 8200,
  } = opts;

  const safeMode = String(mode || "digest").trim().toLowerCase();
  if (!VALID_READ_MODES.has(safeMode)) {
    return {
      text: `Error: Invalid mode "${mode}". Expected one of: digest, turns, artifacts, swarm.`,
      isError: true,
    };
  }

  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const { entry, error } = resolveSessionEntry(dataDir, sessionId);
  if (error || !entry) {
    return { text: `Error: ${error || "Session not found."}`, isError: true };
  }

  const artifacts = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: safeMode === "artifacts" });
  const wsStr = entry.workspaces.join(", ") || "(unknown)";

  if (safeMode === "artifacts") {
    return formatArtifactsMode(entry, artifacts, { artifactName, startLine, endLine, safeMaxChars });
  }

  if (safeMode === "swarm") {
    return formatSwarmMode(entry, { tailMessages, startSeq, endSeq, query, safeMaxChars });
  }

  const turns = parseTranscriptTurns(entry.paths.transcriptPath, {
    hydrateFull: safeMode === "turns",
    transcriptFullPath: entry.paths.transcriptFullPath,
  });
  if (turns.length === 0) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no readable transcript turns yet.`,
      isError: false,
    };
  }

  const firstStep = turns[0]!.startStep;
  const lastStep = turns[turns.length - 1]!.endStep;
  const headerLines = [
    `Session: ${entry.sessionId}`,
    `Title: ${entry.title || "(untitled)"}`,
    `Workspace: ${wsStr}`,
    `Updated: ${formatShortDate(entry.updatedMs)} (${formatRelativeTime(entry.updatedMs)}) · Turns: ${turns.length} · Steps: #${firstStep}-#${lastStep} (${entry.stepCount || lastStep + 1} total)`,
  ];
  if (artifacts.length > 0) {
    const artSummary = artifacts.map((a) => `${a.name} (${a.path})`).join(", ");
    headerLines.push(`Artifacts (${artifacts.length}): ${artSummary}`);
  }
  if (entry.hasSwarm) {
    try {
      const m = JSON.parse(fs.readFileSync(entry.paths.swarmMembersPath, "utf8")) as {
        title?: string;
        members?: Record<string, unknown>;
      };
      const names = Object.keys(m?.members || {}).filter((n) => n !== "coordinator");
      headerLines.push(`Swarm: "${m?.title || ""}" (${names.length} workers: ${names.slice(0, 8).join(", ")})`);
    } catch {
      const boardMsgs = parseSwarmBoardMessages(entry.paths.swarmBoardPath);
      const agents = extractSwarmBoardAgents(boardMsgs).filter((n) => n !== "coordinator");
      if (boardMsgs.length > 0) {
        headerLines.push(
          `Swarm: ${boardMsgs.length} board msgs (#${boardMsgs[0]!.seq}-#${boardMsgs[boardMsgs.length - 1]!.seq}; agents: ${agents.slice(0, 8).join(", ")}) — use mode="swarm"`,
        );
      } else {
        headerLines.push('Swarm: active/recorded (use mode="swarm" to inspect board)');
      }
    }
  }

  if (safeMode === "digest") {
    const compact = turns.length > 6;
    const userLimit = compact ? 130 : 180;
    const ansLimit = compact ? 200 : 260;

    const formatDigestTurn = (t: TranscriptTurn): string => {
      const userOneLine = t.userText.replace(/\s+/g, " ").trim();
      const userClip =
        userOneLine.length > userLimit ? `${safeSliceChars(userOneLine, userLimit - 1)}…` : userOneLine;
      const ansClean = t.finalAssistantText.replace(/\s+/g, " ").trim();
      let ansLine = "";
      if (ansClean) {
        ansLine = ansClean.length > ansLimit ? `${safeSliceChars(ansClean, ansLimit - 1)}…` : ansClean;
      } else if (t.tools.length > 0) {
        ansLine = `[no final reply; tools: ${summarizeToolCounts(t.tools)}]`;
      }
      const toolTag = t.tools.length > 0 ? ` [${t.tools.length} tools]` : "";
      const timeTag = t.createdAt ? ` ${formatShortDate(parseAgyTimestamp(t.createdAt))}` : "";
      const block = [`\nTurn ${t.turnIndex} (#${t.startStep}-${t.endStep}${timeTag})${toolTag}:`];
      if (userClip) block.push(`  User: ${userClip}`);
      if (ansLine) block.push(`  Assistant: ${ansLine}`);
      return block.join("\n");
    };

    const headCount = 2;
    const tailCount = 10;
    const out = [...headerLines, "", "Conversation Digest:"];

    if (turns.length <= headCount + tailCount) {
      for (const t of turns) out.push(formatDigestTurn(t));
    } else {
      const pickedIndices = new Set<number>();
      for (let i = 0; i < headCount; i += 1) pickedIndices.add(i);
      for (let i = turns.length - tailCount; i < turns.length; i += 1) pickedIndices.add(i);

      // Estimate current char/byte budget and sample high-signal middle milestones into unused space
      const baseText = [
        ...out,
        ...[...pickedIndices].sort((a, b) => a - b).map((idx) => formatDigestTurn(turns[idx]!)),
      ].join("\n");
      const remainingChars = safeMaxChars - baseText.length - 360;
      const remainingBytes = 8650 - Buffer.byteLength(baseText, "utf8") - 360;

      if (remainingChars > 400 && remainingBytes > 400) {
        const middleCandidates: Array<{ idx: number; signal: number; rendered: string }> = [];
        for (let i = headCount; i < turns.length - tailCount; i += 1) {
          const t = turns[i]!;
          const substantiveUser = t.userText && !isBoilerplatePrompt(t.userText) ? 20 : 0;
          const replySignal = Math.min(40, Math.floor(t.finalAssistantText.length / 40));
          const toolSignal = Math.min(30, t.tools.length * 3);
          const signal = substantiveUser + replySignal + toolSignal;
          if (signal > 0) {
            middleCandidates.push({ idx: i, signal, rendered: formatDigestTurn(t) });
          }
        }
        middleCandidates.sort((a, b) => b.signal - a.signal);

        let addedChars = 0;
        let addedBytes = 0;
        for (const cand of middleCandidates) {
          if (pickedIndices.size >= headCount + tailCount + 8) break;
          const cBytes = Buffer.byteLength(cand.rendered, "utf8") + 1;
          if (addedChars + cand.rendered.length + 1 > remainingChars || addedBytes + cBytes > remainingBytes) {
            continue;
          }
          pickedIndices.add(cand.idx);
          addedChars += cand.rendered.length + 1;
          addedBytes += cBytes;
        }
      }

      const sortedPicked = [...pickedIndices].sort((a, b) => a - b);
      let prevIdx = -1;
      for (const idx of sortedPicked) {
        if (prevIdx >= 0 && idx > prevIdx + 1) {
          const omitted = idx - prevIdx - 1;
          const midStart = turns[prevIdx + 1]!.startStep;
          const midEnd = turns[idx - 1]!.endStep;
          out.push(`\n… (${omitted} turn(s) omitted, steps #${midStart}-${midEnd}) …`);
        }
        out.push(formatDigestTurn(turns[idx]!));
        prevIdx = idx;
      }
      out.push(
        `\nTip: use search_sessions(sessionId="${entry.shortId}", query="...") to jump to specific topics, or read_session(sessionId="${entry.shortId}", mode="turns", startStep=..., endStep=...).`,
      );
    }
    return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
  }

  // mode === "turns"
  let selected = turns;
  const hasStartStep = typeof startStep === "number" && Number.isFinite(startStep);
  const hasEndStep = typeof endStep === "number" && Number.isFinite(endStep);
  if (hasStartStep || hasEndStep) {
    const s = hasStartStep ? startStep : -Infinity;
    const e = hasEndStep ? endStep : Infinity;
    selected = turns.filter((t) => t.endStep >= s && t.startStep <= e);
    if (selected.length === 0) {
      return {
        text: `Error: No turns matched steps #${hasStartStep ? startStep : "start"}-#${hasEndStep ? endStep : "end"} in ${entry.shortId}. Valid step range: #${firstStep}-#${lastStep} (${turns.length} turns).`,
        isError: true,
      };
    }
  } else {
    const count = Math.max(1, Math.min(40, Number(tailTurns) || 6));
    selected = turns.slice(-count);
  }

  const bodyLines: string[] = [];
  for (const t of selected) {
    const modelTag = t.models.length > 0 ? ` · ${t.models.join(", ")}` : "";
    const fullTag = t.hydratedFromFull ? " · full" : "";
    bodyLines.push(`\n--- Turn ${t.turnIndex} (#${t.startStep}-${t.endStep}${modelTag}${fullTag}) ---`);
    if (t.userText) bodyLines.push(`User:\n${t.userText}`);
    if (includeTools && t.tools.length > 0) {
      bodyLines.push(`Tools: ${summarizeToolCounts(t.tools, 12)}`);
    }
    if (includeThinking && t.thoughts.length > 0) {
      const combined = t.thoughts.map((th) => th.text).join("\n---\n");
      bodyLines.push(`Thinking:\n${safeSliceChars(combined, 1200)}${combined.length > 1200 ? "…" : ""}`);
    }
    if (t.finalAssistantText) {
      bodyLines.push(`Assistant:\n${t.finalAssistantText}`);
    } else if (t.tools.length > 0) {
      bodyLines.push(`Assistant: [no final reply; tools: ${summarizeToolCounts(t.tools)}]`);
    }
  }

  const fullBody = bodyLines.join("\n");
  const safeOffset = Math.max(0, Math.floor(Number(charOffset) || 0));
  if (safeOffset > 0 && safeOffset >= fullBody.length) {
    return {
      text: `Error: charOffset=${safeOffset} exceeds total turns body length (${fullBody.length} chars).`,
      isError: true,
    };
  }

  const slicedBody = safeOffset > 0 ? fullBody.slice(safeOffset) : fullBody;
  const headerBlock = [
    ...headerLines,
    "",
    `Showing ${selected.length} of ${turns.length} turns${safeOffset > 0 ? ` (charOffset=${safeOffset}/${fullBody.length})` : ""}:`,
  ].join("\n");

  const combined = `${headerBlock}\n${slicedBody}`;
  if (combined.length <= safeMaxChars && Buffer.byteLength(combined, "utf8") <= 8650) {
    return { text: combined, isError: false };
  }

  // Compute exact next charOffset for seamless pagination across >8.6 KB hydrated turns
  const footerPlaceholder = `\n… [truncated; pass charOffset=${safeOffset + safeMaxChars} (of ${fullBody.length}) to read more]`;
  const maxContentChars = Math.max(200, safeMaxChars - headerBlock.length - 1 - footerPlaceholder.length - 12);
  const maxContentBytes = Math.max(
    200,
    8650 - Buffer.byteLength(headerBlock, "utf8") - 1 - Buffer.byteLength(footerPlaceholder, "utf8") - 12,
  );
  let chunk = trimTrailingHighSurrogate(slicedBody.slice(0, maxContentChars));
  if (Buffer.byteLength(chunk, "utf8") > maxContentBytes) {
    let lo = 0;
    let hi = chunk.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cand = trimTrailingHighSurrogate(chunk.slice(0, mid));
      if (Buffer.byteLength(cand, "utf8") <= maxContentBytes) lo = mid;
      else hi = mid - 1;
    }
    chunk = trimTrailingHighSurrogate(chunk.slice(0, lo));
  }
  const nextOffset = safeOffset + chunk.length;
  const footer = `\n… [truncated; pass charOffset=${nextOffset} (of ${fullBody.length}) to read more]`;
  return { text: `${headerBlock}\n${chunk.trimEnd()}${footer}`, isError: false };
}

export function readSessionFormatted(opts: ReadSessionOptions = {}): string {
  return readSessionResult(opts).text;
}
