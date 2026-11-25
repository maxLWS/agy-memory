// agy-memory SessionStart Hook (bundled zero-dependency ESM)


// src/snapshot.ts
import fs3 from "node:fs";

// src/adapters.ts
import os from "node:os";
import path from "node:path";
var HEAD_META_BYTES = 16 * 1024;
var CHUNK_BYTES = 64 * 1024;
function resolveCodexDir() {
  return (process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
}
function resolveClaudeDir() {
  return (process.env.CLAUDE_CONFIG_DIR || "").trim() || path.join(os.homedir(), ".claude");
}

// src/notes.ts
import crypto from "node:crypto";
import fs2 from "node:fs";
import path3 from "node:path";

// src/store.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os2 from "node:os";
import path2 from "node:path";
var TAIL_PREVIEW_BYTES = 160 * 1024;
var TAIL_FALLBACK_BYTES = 1024 * 1024;
var SQLITE_CANDIDATES = process.platform === "win32" ? ["sqlite3", "sqlite3.exe"] : ["sqlite3", "/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"];
var PYTHON_INVOCATIONS = process.platform === "win32" ? [
  { bin: "python", prefixArgs: [] },
  { bin: "python3", prefixArgs: [] },
  { bin: "py", prefixArgs: ["-3"] }
] : [
  { bin: "python3", prefixArgs: [] },
  { bin: "/usr/bin/python3", prefixArgs: [] },
  { bin: "python", prefixArgs: [] }
];
var TRUNCATION_SUFFIX = "\n\u2026 [truncated to fit inline budget]";
var MAX_TURN_CACHE_ENTRIES = 64;
var MAX_FULL_CACHE_ENTRIES = 32;
var catalogCache = /* @__PURE__ */ new Map();
var turnsCache = /* @__PURE__ */ new Map();
var fullStepsCache = /* @__PURE__ */ new Map();
var cachedNodeSqliteCtor;
function getNodeSqliteCtor() {
  if (cachedNodeSqliteCtor !== void 0) return cachedNodeSqliteCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite");
    cachedNodeSqliteCtor = typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    cachedNodeSqliteCtor = null;
  }
  return cachedNodeSqliteCtor;
}
function lruSet(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "missing";
  }
}
function resolveDataDir(overrideDir = "") {
  if (overrideDir && String(overrideDir).trim()) {
    return path2.resolve(String(overrideDir).trim());
  }
  const envDir = process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "";
  if (envDir.trim()) {
    return path2.isAbsolute(envDir.trim()) ? envDir.trim() : path2.join(os2.homedir(), ".gemini", envDir.trim());
  }
  const cliDir = path2.join(os2.homedir(), ".gemini", "antigravity-cli");
  if (fs.existsSync(cliDir)) return cliDir;
  const ideDir = path2.join(os2.homedir(), ".gemini", "antigravity");
  if (fs.existsSync(ideDir)) return ideDir;
  return cliDir;
}
function parseAgyTimestamp(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e14 ? Math.floor(raw / 1e6) : raw;
  }
  const text = String(raw ?? "").trim();
  if (!text) return 0;
  const normalized = text.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, "$1T$2").replace(/(\.\d{3})\d+/, "$1");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}
function formatRelativeTime(ms, now = Date.now()) {
  if (!ms || ms <= 0) return "unknown";
  const diffSec = Math.max(0, Math.floor((now - ms) / 1e3));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
function trimTrailingHighSurrogate(str) {
  if (!str) return "";
  const lastCode = str.charCodeAt(str.length - 1);
  if (lastCode >= 55296 && lastCode <= 56319) {
    return str.slice(0, -1);
  }
  return str;
}
function safeSliceChars(text, maxLen) {
  const s = String(text || "");
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return trimTrailingHighSurrogate(s.slice(0, maxLen));
}
function truncateUtf8(text, maxChars = 8200, maxBytes = 8650, customSuffix = TRUNCATION_SUFFIX) {
  const raw = String(text || "");
  const suffix = String(customSuffix || TRUNCATION_SUFFIX);
  const suffixChars = suffix.length;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const safeMaxChars = Math.max(
    suffixChars + 16,
    Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 8200
  );
  const safeMaxBytes = Math.max(
    suffixBytes + 16,
    Number.isFinite(Number(maxBytes)) ? Math.floor(Number(maxBytes)) : 8650
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
function cleanUserRequestText(raw) {
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
function decodeWorkspaceUris(rawJson) {
  if (!rawJson) return [];
  let list = [];
  if (Array.isArray(rawJson)) {
    list = rawJson;
  } else {
    try {
      const parsed = JSON.parse(String(rawJson));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      return [];
    }
  }
  return list.map((u) => {
    const s = String(u ?? "").trim();
    if (!s) return "";
    if (s.startsWith("file://")) {
      let stripped = s.slice("file://".length);
      try {
        stripped = decodeURIComponent(stripped);
      } catch {
      }
      return stripped.replace(/^\/([A-Za-z]:\/)/, "$1");
    }
    return s;
  }).filter(Boolean);
}
function normalizeFsPath(rawPath) {
  const trimmed = String(rawPath || "").trim();
  const normalized = trimmed.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:\/)/, "$1").replace(/\/+$/, "").toLowerCase();
  return normalized || (trimmed === "/" ? "/" : "");
}
function isTempPath(rawPath) {
  const norm = normalizeFsPath(rawPath);
  if (!norm) return false;
  if (norm === "/tmp" || norm.startsWith("/tmp/") || norm === "/private/tmp" || norm.startsWith("/private/tmp/")) {
    return true;
  }
  const osTmp = normalizeFsPath(os2.tmpdir());
  if (osTmp && (norm === osTmp || norm.startsWith(`${osTmp}/`))) {
    return true;
  }
  return false;
}
function formatWorkspaceLabel(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "";
  if (isTempPath(trimmed)) return trimmed;
  const slashNorm = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return path2.posix.basename(slashNorm) || trimmed;
}
function workspaceMatches(workspaces, filter) {
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
    const base = path2.posix.basename(norm);
    return base === f || norm.endsWith(`/${f}`) || norm.includes(`/${f}/`);
  });
}
function noteWorkspaceMatches(noteWorkspace, filterWorkspace) {
  const fw = normalizeFsPath(filterWorkspace);
  if (!fw) return true;
  const nw = normalizeFsPath(noteWorkspace);
  if (!nw) return true;
  if (nw === fw) return true;
  const isAbsFilter = fw.startsWith("/") || /^[a-z]:\//.test(fw);
  if (isAbsFilter) {
    return nw.startsWith(`${fw}/`) || fw.startsWith(`${nw}/`);
  }
  const base = path2.posix.basename(nw);
  return base === fw || nw.endsWith(`/${fw}`) || nw.includes(`/${fw}/`);
}
function parseSessionIdList(spec) {
  if (!spec) return [];
  const rawItems = Array.isArray(spec) ? spec : String(spec).split(",");
  return rawItems.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean);
}
function splitCanonicalRef(ref) {
  const clean = String(ref || "").trim();
  const m = /^(agy|codex|claude):(.+)$/i.exec(clean);
  if (m) {
    return { source: m[1].toLowerCase(), id: m[2].trim() };
  }
  return { source: null, id: clean };
}
function matchesSessionId(sessionId, filterSpec, entrySource = "agy") {
  const targets = parseSessionIdList(filterSpec);
  if (targets.length === 0) return false;
  const sid = String(sessionId || "").trim().toLowerCase();
  if (!sid) return false;
  return targets.some((rawTarget) => {
    const { source: targetSrc, id: targetId } = splitCanonicalRef(rawTarget);
    if (targetSrc && targetSrc !== entrySource) return false;
    const tid = targetId.toLowerCase();
    if (!tid) return false;
    if (sid === tid) return true;
    if (tid.length >= 4 && sid.startsWith(tid)) return true;
    return false;
  });
}
function readTailUtf8(filePath, maxBytes) {
  let fd = null;
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
      }
    }
  }
}
function getSessionPaths(dataDir, sessionId) {
  const brainDir = path2.join(dataDir, "brain", sessionId);
  const systemDir = path2.join(brainDir, ".system_generated");
  const logsDir = path2.join(systemDir, "logs");
  const swarmDir = path2.join(systemDir, "swarm");
  return {
    brainDir,
    systemDir,
    transcriptPath: path2.join(logsDir, "transcript.jsonl"),
    transcriptFullPath: path2.join(logsDir, "transcript_full.jsonl"),
    swarmDir,
    swarmMembersPath: path2.join(swarmDir, "members.json"),
    swarmBoardPath: path2.join(swarmDir, "board.jsonl"),
    swarmPlanPath: path2.join(swarmDir, "plan.json"),
    subagentsDir: path2.join(systemDir, "subagents")
  };
}
function listSessionArtifactFiles(brainDir, { includeMeta = true } = {}) {
  try {
    const names = fs.readdirSync(brainDir).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    return names.map((name) => {
      const filePath = path2.join(brainDir, name);
      let updatedAt = 0;
      let size = 0;
      try {
        const st = fs.statSync(filePath);
        updatedAt = st.mtimeMs || 0;
        size = st.size || 0;
      } catch {
      }
      let summary = "";
      if (includeMeta) {
        const metaPath = `${filePath}.metadata.json`;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          summary = String(meta.summary || meta.Summary || "").trim();
        } catch {
        }
      }
      return { name, path: filePath, summary, updatedAt, size };
    });
  } catch {
    return [];
  }
}
function isBoilerplatePrompt(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return true;
  if (/^\/[a-z0-9_-]+(?:\s+\S+)?$/i.test(clean) && clean.length <= 24) return true;
  if (clean.length <= 12) {
    const low = clean.toLowerCase();
    if (/^(ok|okay|yes|no|go|continue|resume|proceed|done|thanks|thx|hi|hello|ping|test|继续|好的|好|行|嗯|收到|开始|确认|ok\s*继续|继续吧|全局安装)[.!。！?？\s]*$/i.test(
      low
    )) {
      return true;
    }
    if (clean.length <= 5) return true;
  }
  return false;
}
function extractUserPromptFromTailText(tailText, preferSubstantive) {
  const lines = tailText.split("\n");
  let fallbackLatest = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (!line || !line.includes('"USER_INPUT"')) continue;
    try {
      const step = JSON.parse(line);
      if (step && step.type === "USER_INPUT") {
        const cleaned = cleanUserRequestText(step.content || "").replace(/\s+/g, " ").trim();
        if (!cleaned) continue;
        if (!fallbackLatest) fallbackLatest = cleaned;
        if (!preferSubstantive || !isBoilerplatePrompt(cleaned)) {
          return { best: cleaned, fallbackLatest };
        }
      }
    } catch {
    }
  }
  return { best: "", fallbackLatest };
}
function readLastUserPromptSnippet(transcriptPath, maxLen = 140, { preferSubstantive = false } = {}) {
  const cached = turnsCache.get(transcriptPath);
  if (cached && cached.sig === statSignature(transcriptPath) && cached.turns.length > 0) {
    let fallbackLatest2 = "";
    for (let i = cached.turns.length - 1; i >= 0; i -= 1) {
      const turn = cached.turns[i];
      const cleaned = turn.userText.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      if (!fallbackLatest2) fallbackLatest2 = cleaned;
      if (!preferSubstantive || !isBoilerplatePrompt(cleaned)) {
        return cleaned.length > maxLen ? `${safeSliceChars(cleaned, maxLen - 1)}\u2026` : cleaned;
      }
    }
    if (fallbackLatest2) {
      return fallbackLatest2.length > maxLen ? `${safeSliceChars(fallbackLatest2, maxLen - 1)}\u2026` : fallbackLatest2;
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
  if (!best && !fallbackLatest && first.totalSize > TAIL_FALLBACK_BYTES) {
    const turns = parseTranscriptTurns(transcriptPath);
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const cleaned = turns[i].userText.replace(/\s+/g, " ").trim();
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
  return chosen.length > maxLen ? `${safeSliceChars(chosen, maxLen - 1)}\u2026` : chosen;
}
var SUMMARY_SELECT_SQL = [
  "SELECT conversation_id, title, preview, step_count, last_modified_time,",
  "workspace_uris, status, parent_conversation_id, nesting_depth, last_user_input_time",
  "FROM conversation_summaries",
  "ORDER BY last_modified_time DESC"
].join(" ");
function mapDbRow(r) {
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
    lastUserInputTime: String(r.last_user_input_time ?? "")
  };
}
function querySummariesViaNodeSqlite(dbPath) {
  const DatabaseSync = getNodeSqliteCtor();
  if (!DatabaseSync) return null;
  let db = null;
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
      }
    }
  }
}
function querySummariesViaSqliteCli(dbPath) {
  const sql = `${SUMMARY_SELECT_SQL};`;
  for (const sqliteBin of SQLITE_CANDIDATES) {
    try {
      const stdout = execFileSync(sqliteBin, ["-readonly", "-json", dbPath, sql], {
        encoding: "utf8",
        timeout: 2500,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const trimmed = String(stdout || "").trim();
      if (!trimmed) return [];
      const rows = JSON.parse(trimmed);
      if (!Array.isArray(rows)) continue;
      return rows.map(mapDbRow);
    } catch {
    }
  }
  return null;
}
function querySummariesViaPython(dbPath) {
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
        timeout: 3e3,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"]
      });
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  return null;
}
function scanBrainDirsFallback(dataDir) {
  const brainRoot = path2.join(dataDir, "brain");
  let dirs = [];
  try {
    dirs = fs.readdirSync(brainRoot);
  } catch {
    return [];
  }
  const childIds = /* @__PURE__ */ new Set();
  for (const id of dirs) {
    const p = getSessionPaths(dataDir, id);
    try {
      const subFiles = fs.readdirSync(p.subagentsDir).filter((f) => f.endsWith(".json"));
      for (const f of subFiles) childIds.add(f.replace(/\.json$/, ""));
    } catch {
    }
    try {
      const members = JSON.parse(fs.readFileSync(p.swarmMembersPath, "utf8"));
      for (const m of Object.values(members?.members || {})) {
        if (m?.conversation_id && m.conversation_id !== id) {
          childIds.add(m.conversation_id);
        }
      }
    } catch {
    }
  }
  const out = [];
  for (const id of dirs) {
    if (id.startsWith(".")) continue;
    const p = getSessionPaths(dataDir, id);
    let st = null;
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
      lastUserInputTime: ""
    });
  }
  out.sort((a, b) => parseAgyTimestamp(b.lastModifiedTime) - parseAgyTimestamp(a.lastModifiedTime));
  return out;
}
function computeCatalogSignature(dataDir) {
  const dbPath = path2.join(dataDir, "conversation_summaries.db");
  const walPath = `${dbPath}-wal`;
  const brainRoot = path2.join(dataDir, "brain");
  return `${statSignature(dbPath)}|${statSignature(walPath)}|${statSignature(brainRoot)}`;
}
function loadSessionCatalog(dataDir = resolveDataDir()) {
  const resolvedDir = path2.resolve(dataDir);
  const sig = computeCatalogSignature(resolvedDir);
  const cached = catalogCache.get(resolvedDir);
  if (cached && cached.sig === sig) {
    for (const entry of cached.entries) {
      if (!entry.hasTranscript && fs.existsSync(entry.paths.transcriptPath)) {
        entry.hasTranscript = true;
      }
      if (!entry.hasSwarm && (fs.existsSync(entry.paths.swarmMembersPath) || fs.existsSync(entry.paths.swarmBoardPath))) {
        entry.hasSwarm = true;
      }
    }
    return cached.entries;
  }
  const dbPath = path2.join(resolvedDir, "conversation_summaries.db");
  let rawRows = null;
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
  const seen = new Set(rawRows.map((r) => r.conversationId));
  const brainRoot = path2.join(resolvedDir, "brain");
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
        lastUserInputTime: ""
      });
    }
  } catch {
  }
  const entries = rawRows.map((row) => {
    const paths = getSessionPaths(resolvedDir, row.conversationId);
    const workspaces = decodeWorkspaceUris(row.workspaceUris);
    const updatedMs = Math.max(
      parseAgyTimestamp(row.lastModifiedTime),
      parseAgyTimestamp(row.lastUserInputTime)
    );
    const hasTranscript = fs.existsSync(paths.transcriptPath);
    const hasSwarm = fs.existsSync(paths.swarmMembersPath) || fs.existsSync(paths.swarmBoardPath);
    const isChild = Boolean(row.parentConversationId) || (row.nestingDepth || 0) > 0;
    return {
      source: "agy",
      canonicalId: `agy:${row.conversationId}`,
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
      paths
    };
  }).sort((a, b) => b.updatedMs - a.updatedMs);
  catalogCache.set(resolvedDir, { sig, entries });
  return entries;
}
function loadFullTranscriptStepMap(transcriptFullPath) {
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
  const stepMap = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('"PLANNER_RESPONSE"')) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
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
function parseTranscriptTurns(transcriptPath, { hydrateFull = false, transcriptFullPath = "" } = {}) {
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
    const turns = [];
    let currentTurn = null;
    let hasTruncatedContent = false;
    const ensureTurn = (stepIndex, createdAt) => {
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
          models: /* @__PURE__ */ new Set()
        };
        turns.push(currentTurn);
      }
      return currentTurn;
    };
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.includes('"USER_INPUT"') && !trimmed.includes('"PLANNER_RESPONSE"')) continue;
      let step;
      try {
        step = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const idx = typeof step.step_index === "number" ? step.step_index : -1;
      const createdAt = typeof step.created_at === "string" ? step.created_at : "";
      const contentTruncated = Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content");
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
          models: /* @__PURE__ */ new Set()
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
          for (const tc of step.tool_calls) {
            if (tc?.name) turn.tools.push({ stepIndex: idx, name: String(tc.name) });
          }
        }
        if (typeof step.content === "string" && step.content.trim()) {
          if (contentTruncated) hasTruncatedContent = true;
          turn.assistantResponses.push({
            stepIndex: idx,
            createdAt,
            text: step.content.trim(),
            contentTruncated
          });
        }
      }
    }
    const materialized = turns.map((t) => {
      const lastResp = t.assistantResponses[t.assistantResponses.length - 1];
      return {
        ...t,
        models: [...t.models],
        finalAssistantText: lastResp ? lastResp.text : "",
        finalAssistantTruncated: lastResp ? Boolean(lastResp.contentTruncated) : false
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
    const hydratedUser = needsUser ? fullMap.get(t.userStepIndex) ?? t.userText : t.userText;
    const hydratedResponses = needsAssistant ? t.assistantResponses.map(
      (r) => r.contentTruncated && fullMap.has(r.stepIndex) ? { ...r, text: fullMap.get(r.stepIndex) ?? r.text, hydrated: true } : r
    ) : t.assistantResponses;
    const lastResp = hydratedResponses[hydratedResponses.length - 1];
    return {
      ...t,
      userText: hydratedUser,
      assistantResponses: hydratedResponses,
      finalAssistantText: lastResp ? lastResp.text : "",
      hydratedFromFull: true
    };
  });
}

// src/notes.ts
var INDEX_START = "<!-- agy-memory:index:start -->";
var INDEX_END = "<!-- agy-memory:index:end -->";
var MAX_INDEX_LINES = 150;
var FRONTMATTER_SCHEMA_VERSION = 1;
var VALID_NOTE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
var LOCK_TIMEOUT_MS = 1500;
var STALE_LOCK_MS = 1e4;
function getNotesPath(dataDir = resolveDataDir()) {
  return path3.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}
function getMemoryDir(dataDir = resolveDataDir()) {
  return path3.join(dataDir, "plugin_data", "agy-memory", "memory");
}
function getMemoryIndexPath(dataDir = resolveDataDir()) {
  return path3.join(getMemoryDir(dataDir), "MEMORY.md");
}
function getTopicsDir(dataDir = resolveDataDir()) {
  return path3.join(getMemoryDir(dataDir), "topics");
}
function isValidNoteId(id) {
  return VALID_NOTE_ID_RE.test(id);
}
function getTopicFilePath(dataDir, validatedId) {
  if (!isValidNoteId(validatedId)) {
    throw new Error(`Invalid note ID "${validatedId}". Use 1-64 ASCII letters, digits, '_' or '-' starting with a letter/digit.`);
  }
  return path3.join(getTopicsDir(dataDir), `${validatedId}.md`);
}
function computeRevision(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}
function writeTextAtomic(filePath, payload) {
  const dir = path3.dirname(filePath);
  fs2.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs2.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 384, flag: "wx" });
    fs2.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs2.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}
function withNotesLock(dataDir, fn) {
  const memDir = getMemoryDir(dataDir);
  fs2.mkdirSync(memDir, { recursive: true, mode: 448 });
  const lockPath = path3.join(memDir, ".notes.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs2.openSync(lockPath, "wx", 384);
      fs2.writeSync(fd, `${process.pid}:${Date.now()}
`);
      fs2.closeSync(fd);
      acquired = true;
    } catch (err) {
      const code = err?.code;
      if (code !== "EEXIST") throw err;
      try {
        const st = fs2.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs2.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for notes lock (${lockPath}); retry after concurrent write completes.`);
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs2.unlinkSync(lockPath);
    } catch {
    }
  }
}
function normalizeTagsInput(rawTags) {
  let list = [];
  if (Array.isArray(rawTags)) {
    list = rawTags;
  } else if (typeof rawTags === "string" && rawTags.trim()) {
    list = rawTags.split(",");
  }
  return [...new Set(list.map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))];
}
function serializeTopicMarkdown(note) {
  const fm = [
    "---",
    `schema: ${FRONTMATTER_SCHEMA_VERSION}`,
    `id: ${JSON.stringify(note.id)}`,
    `topic: ${JSON.stringify(note.topic)}`,
    `workspace: ${JSON.stringify(note.workspace || "")}`,
    `tags: ${JSON.stringify(note.tags || [])}`,
    `sessionId: ${JSON.stringify(note.sessionId || "")}`,
    `createdAt: ${Number(note.createdAt) || Date.now()}`,
    `updatedAt: ${Number(note.updatedAt) || Date.now()}`,
    "---"
  ].join("\n");
  return `${fm}

${note.content.replace(/^\n+/, "").trimEnd()}
`;
}
function parseFrontmatterValue(rawVal) {
  const v = rawVal.trim();
  if (!v) return { value: "", error: null };
  if (v.startsWith('"') || v.startsWith("[") || v.startsWith("{")) {
    try {
      return { value: JSON.parse(v), error: null };
    } catch {
      return { value: null, error: `Malformed JSON-quoted frontmatter value: ${v.slice(0, 60)}` };
    }
  }
  if (v === "true") return { value: true, error: null };
  if (v === "false") return { value: false, error: null };
  if (v === "null") return { value: null, error: null };
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return { value: Number(v), error: null };
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return { value: v.slice(1, -1).replace(/''/g, "'"), error: null };
  }
  return { value: v, error: null };
}
function parseTopicMarkdown(raw, filePath) {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { note: null, error: `Malformed frontmatter (missing opening ---) in ${filePath}` };
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  const endIdxEof = endIdx === -1 && normalized.endsWith("\n---") ? normalized.length - 4 : endIdx;
  if (endIdxEof < 0) {
    return { note: null, error: `Malformed frontmatter (missing closing ---) in ${filePath}` };
  }
  const headerLines = normalized.slice(4, endIdxEof).split("\n");
  const rawBody = endIdx >= 0 ? normalized.slice(endIdx + 5) : "";
  const body = rawBody.replace(/^\n+/, "").trimEnd();
  const meta = {};
  for (const line of headerLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      return { note: null, error: `Invalid frontmatter line "${trimmed}" in ${filePath}` };
    }
    const key = line.slice(0, colon).trim();
    const parsed = parseFrontmatterValue(line.slice(colon + 1));
    if (parsed.error) {
      return { note: null, error: `${parsed.error} in ${filePath}` };
    }
    meta[key] = parsed.value;
  }
  const schemaVer = Number(meta.schema);
  if (meta.schema !== void 0 && (!Number.isInteger(schemaVer) || schemaVer !== FRONTMATTER_SCHEMA_VERSION)) {
    return { note: null, error: `Unsupported frontmatter schema "${String(meta.schema)}" in ${filePath}` };
  }
  const id = String(meta.id || "").trim();
  const topic = String(meta.topic || "").trim();
  if (!id || !topic) {
    return { note: null, error: `Missing required frontmatter id/topic in ${filePath}` };
  }
  if (!isValidNoteId(id)) {
    return { note: null, error: `Invalid frontmatter id "${id}" in ${filePath}` };
  }
  if (!body.trim()) {
    return { note: null, error: `Empty note body in ${filePath}` };
  }
  let stMtime = Date.now();
  try {
    stMtime = Math.round(fs2.statSync(filePath).mtimeMs);
  } catch {
  }
  const note = {
    id,
    topic,
    content: body,
    workspace: String(meta.workspace || "").trim(),
    tags: normalizeTagsInput(meta.tags),
    sessionId: String(meta.sessionId || "").trim(),
    createdAt: Number(meta.createdAt) || stMtime,
    updatedAt: Number(meta.updatedAt) || stMtime,
    filePath,
    revision: computeRevision(raw)
  };
  return { note, error: null };
}
function rebuildMemoryIndexFile(dataDir, notes) {
  const indexPath = getMemoryIndexPath(dataDir);
  const sorted = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const indexRows = [
    INDEX_START,
    `<!-- Auto-maintained index (${sorted.length} notes; topics/*.md files are authoritative) -->`
  ];
  const maxRows = Math.max(10, MAX_INDEX_LINES - 12);
  for (const n of sorted.slice(0, maxRows)) {
    const ws = n.workspace ? ` \xB7 ${formatWorkspaceLabel(n.workspace)}` : "";
    const tags = n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const preview = n.content.replace(/\s+/g, " ").trim();
    const shortPrev = preview.length > 100 ? `${safeSliceChars(preview, 99)}\u2026` : preview;
    const relName = n.filePath ? path3.basename(n.filePath) : `${n.id}.md`;
    indexRows.push(`- **[${n.id}] ${n.topic}**${tags}${ws} \u2192 \`topics/${relName}\` \u2014 ${shortPrev}`);
  }
  if (sorted.length > maxRows) {
    indexRows.push(`- \u2026 (${sorted.length - maxRows} additional note(s) in \`topics/\`; use \`recall_notes\` to query all)`);
  }
  indexRows.push(INDEX_END);
  const managedBlock = indexRows.join("\n");
  let finalDoc = `# agy-memory Index

Add personal notes above or below the managed markers; topic files in \`topics/\` are authoritative.

${managedBlock}
`;
  if (fs2.existsSync(indexPath)) {
    try {
      const existing = fs2.readFileSync(indexPath, "utf8").replace(/\r\n/g, "\n");
      const sIdx = existing.indexOf(INDEX_START);
      const eIdx = existing.indexOf(INDEX_END);
      if (sIdx >= 0 && eIdx > sIdx) {
        finalDoc = `${existing.slice(0, sIdx)}${managedBlock}${existing.slice(eIdx + INDEX_END.length)}`;
      } else if (existing.trim()) {
        finalDoc = `${existing.trimEnd()}

${managedBlock}
`;
      }
    } catch {
    }
  }
  writeTextAtomic(indexPath, finalDoc);
}
function sanitizeLegacyNoteId(rawId) {
  const trimmed = String(rawId || "").trim();
  if (isValidNoteId(trimmed)) return trimmed;
  const hash = crypto.createHash("sha256").update(trimmed || crypto.randomBytes(8).toString("hex")).digest("hex").slice(0, 8);
  const prefix = trimmed.replace(/[^a-zA-Z0-9_-]/g, "").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 48);
  return prefix ? `${prefix}-${hash}` : `note-${hash}`;
}
function readTopicsFromDisk(dataDir, warnings) {
  const topicsDir = getTopicsDir(dataDir);
  if (!fs2.existsSync(topicsDir)) return [];
  const notes = [];
  const seenIds = /* @__PURE__ */ new Map();
  let entries = [];
  try {
    entries = fs2.readdirSync(topicsDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
  for (const name of entries) {
    const filePath = path3.join(topicsDir, name);
    try {
      const raw = fs2.readFileSync(filePath, "utf8");
      const { note, error } = parseTopicMarkdown(raw, filePath);
      if (error || !note) {
        warnings.push(error || `Unreadable topic note: ${filePath}`);
        continue;
      }
      if (seenIds.has(note.id)) {
        warnings.push(`Duplicate note ID "${note.id}" in ${filePath} (already defined in ${seenIds.get(note.id)})`);
        continue;
      }
      seenIds.set(note.id, filePath);
      notes.push(note);
    } catch {
      warnings.push(`Could not read topic note: ${filePath}`);
    }
  }
  return notes;
}
function loadLegacyJsonNotesReadOnly(dataDir) {
  const filePath = getNotesPath(dataDir);
  const warnings = [];
  if (!fs2.existsSync(filePath)) return { notes: [], warnings };
  try {
    const parsed = JSON.parse(fs2.readFileSync(filePath, "utf8"));
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
    return { notes, warnings };
  } catch {
    warnings.push(`Malformed legacy notes file preserved untouched: ${filePath}`);
    return { notes: [], warnings };
  }
}
function maybeMigrateLegacyNotesJson(dataDir, warnings) {
  const legacyPath = getNotesPath(dataDir);
  if (!fs2.existsSync(legacyPath)) return;
  const markerPath = path3.join(getMemoryDir(dataDir), ".migrated_v1_json");
  if (fs2.existsSync(markerPath)) return;
  withNotesLock(dataDir, () => {
    if (fs2.existsSync(markerPath)) return;
    let legacyNotes = [];
    try {
      const parsed = JSON.parse(fs2.readFileSync(legacyPath, "utf8"));
      if (!Array.isArray(parsed?.notes)) {
        warnings.push(`Legacy ${legacyPath} has invalid structure; preserved untouched.`);
        return;
      }
      legacyNotes = parsed.notes;
    } catch {
      warnings.push(`Legacy ${legacyPath} could not be parsed as JSON; preserved untouched.`);
      return;
    }
    const topicsDir = getTopicsDir(dataDir);
    fs2.mkdirSync(topicsDir, { recursive: true, mode: 448 });
    let allVerified = true;
    let migratedAny = false;
    for (let i = 0; i < legacyNotes.length; i += 1) {
      const raw = legacyNotes[i];
      const topic = String(raw.topic || "").trim();
      const content = String(raw.content || "").replace(/^\n+/, "").trimEnd();
      if (!topic || !content.trim()) {
        allVerified = false;
        warnings.push(`Legacy note #${i + 1} has empty topic/content; legacy notes.json retained for inspection.`);
        continue;
      }
      const id = sanitizeLegacyNoteId(String(raw.id || ""));
      const dst = getTopicFilePath(dataDir, id);
      if (fs2.existsSync(dst)) {
        try {
          const existingParsed = parseTopicMarkdown(fs2.readFileSync(dst, "utf8"), dst);
          if (existingParsed.note && existingParsed.note.id === id && existingParsed.note.topic === topic && existingParsed.note.content === content) {
            continue;
          }
        } catch {
        }
        allVerified = false;
        warnings.push(`Migration collision for legacy note "${id}" (${dst} already exists with different content); preserved untouched.`);
        continue;
      }
      const normalized = {
        id,
        topic,
        content,
        workspace: String(raw.workspace || "").trim(),
        tags: normalizeTagsInput(raw.tags),
        sessionId: String(raw.sessionId || "").trim(),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now()
      };
      writeTextAtomic(dst, serializeTopicMarkdown(normalized));
      const verify = parseTopicMarkdown(fs2.readFileSync(dst, "utf8"), dst);
      if (!verify.note || verify.note.id !== normalized.id || verify.note.topic !== normalized.topic || verify.note.content !== normalized.content) {
        allVerified = false;
        warnings.push(`Migration verification failed for note ${id}; legacy notes.json retained.`);
      } else {
        migratedAny = true;
      }
    }
    if (migratedAny || fs2.existsSync(topicsDir)) {
      const freshWarnings = [];
      const currentNotes = readTopicsFromDisk(dataDir, freshWarnings);
      if (currentNotes.length > 0 && !fs2.existsSync(getMemoryIndexPath(dataDir))) {
        rebuildMemoryIndexFile(dataDir, currentNotes);
      }
    }
    if (allVerified) {
      writeTextAtomic(markerPath, `migrated_at=${(/* @__PURE__ */ new Date()).toISOString()}
count=${legacyNotes.length}
`);
    }
  });
}
function loadNotesWithDiagnostics(dataDir = resolveDataDir(), opts = {}) {
  const warnings = [];
  const topicsDir = getTopicsDir(dataDir);
  const memoryIndexPath = getMemoryIndexPath(dataDir);
  if (opts.readOnly) {
    const topicNotes = readTopicsFromDisk(dataDir, warnings);
    if (topicNotes.length > 0 || fs2.existsSync(topicsDir)) {
      return { notes: topicNotes, warnings, memoryIndexPath, topicsDir };
    }
    const legacy = loadLegacyJsonNotesReadOnly(dataDir);
    return {
      notes: legacy.notes,
      warnings: [...warnings, ...legacy.warnings],
      memoryIndexPath: getNotesPath(dataDir),
      topicsDir
    };
  }
  maybeMigrateLegacyNotesJson(dataDir, warnings);
  const notes = readTopicsFromDisk(dataDir, warnings);
  return { notes, warnings, memoryIndexPath, topicsDir };
}
function loadNotes(dataDir = resolveDataDir(), opts = {}) {
  return loadNotesWithDiagnostics(dataDir, opts).notes;
}

// src/snapshot.ts
function firstNonEmptyString(values) {
  if (!Array.isArray(values)) return "";
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}
function isTmpPrimaryWorkspace(workspaces) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return false;
  return isTempPath(workspaces[0] ?? "");
}
function buildSessionStartSnapshot(payload = {}, dataDir = resolveDataDir()) {
  const currentId = String(
    payload?.conversationId || payload?.conversation_id || payload?.sessionId || payload?.session_id || ""
  ).trim();
  const primaryWs = typeof payload?.cwd === "string" && payload.cwd.trim() || firstNonEmptyString(payload?.workspacePaths) || firstNonEmptyString(payload?.workspace_paths) || firstNonEmptyString(payload?.workspaceRoots) || firstNonEmptyString(payload?.workspace_roots) || "";
  const isCurrentTmp = isTempPath(primaryWs);
  const now = Date.now();
  const catalog = loadSessionCatalog(dataDir);
  const eligible = catalog.filter((s) => {
    if (s.isChild) return false;
    if (currentId && matchesSessionId(s.sessionId, currentId)) return false;
    if (primaryWs && !workspaceMatches(s.workspaces, primaryWs)) return false;
    return s.hasTranscript || Boolean(s.title);
  });
  const substantive = [];
  const minor = [];
  for (const s of eligible) {
    const tmpLeak = !isCurrentTmp && isTmpPrimaryWorkspace(s.workspaces);
    const hasSubstance = !tmpLeak && Boolean(s.title) && (s.stepCount >= 5 || s.hasSwarm);
    if (hasSubstance) {
      substantive.push(s);
    } else if (!tmpLeak) {
      minor.push(s);
    }
  }
  const recent = [...substantive, ...minor].slice(0, 5);
  const notes = loadNotes(dataDir, { readOnly: true }).filter((n) => noteWorkspaceMatches(n.workspace, primaryWs)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);
  if (recent.length === 0 && notes.length === 0 && !currentId) {
    return "";
  }
  const lines = ["[agy-memory] Local cross-conversation context (read-only snapshot):"];
  if (currentId) {
    const shortCur = currentId.slice(0, 8);
    lines.push(`Current session: ${shortCur} (pass excludeSessionId="agy:${currentId}" when searching past sessions)`);
  }
  if (recent.length > 0) {
    const wsLabel = primaryWs ? formatWorkspaceLabel(primaryWs) : "";
    const wsTag = wsLabel ? ` in ${wsLabel}` : "";
    lines.push(`Recent sessions${wsTag}:`);
    for (const s of recent) {
      const snippet = s.hasTranscript ? readLastUserPromptSnippet(s.paths.transcriptPath, 88, { preferSubstantive: true }) : "";
      const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
      const flags = [];
      if (s.hasSwarm) flags.push("swarm");
      if (artifacts.length > 0) flags.push(`${artifacts.length}art`);
      const badge = flags.length > 0 ? ` [${flags.join(",")}]` : "";
      const stepPart = s.stepCount > 0 ? `, ${s.stepCount} steps` : "";
      const title = s.title || "(untitled)";
      lines.push(
        `- ${s.shortId} (${formatRelativeTime(s.updatedMs, now)}${stepPart})${badge} ${title}${snippet ? ` \u2014 "${snippet}"` : ""}`
      );
    }
  }
  if (notes.length > 0) {
    lines.push("Pinned notes:");
    for (const n of notes) {
      const text = String(n.content || "").replace(/\s+/g, " ").trim();
      const clip = text.length > 140 ? `${safeSliceChars(text, 139)}\u2026` : text;
      const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
      lines.push(`- [${n.id}] ${n.topic}${tagPart}: ${clip}`);
    }
  }
  const extAvail = [];
  if (fs3.existsSync(resolveCodexDir())) extAvail.push("codex");
  if (fs3.existsSync(resolveClaudeDir())) extAvail.push("claude");
  const extHint = extAvail.length > 0 ? ` Cross-CLI sources: ${extAvail.join(", ")} (source="all").` : "";
  lines.push(`Use agy-memory tools when needed.${extHint}`);
  return truncateUtf8(lines.join("\n"), 1650, 1800);
}

// src/session-start.ts
async function readStdinJson() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}
async function main() {
  const payload = await readStdinJson();
  const text = buildSessionStartSnapshot(payload);
  if (!text) {
    process.stdout.write("{}\n");
    return;
  }
  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text
        }
      }
    ]
  };
  process.stdout.write(`${JSON.stringify(output)}
`);
}
main().catch(() => {
  process.stdout.write("{}\n");
});
