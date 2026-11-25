// agy-memory SessionStart Hook (bundled zero-dependency ESM)


// src/notes.ts
import fs2 from "node:fs";
import path2 from "node:path";

// src/store.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
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
    return path.resolve(String(overrideDir).trim());
  }
  const envDir = process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "";
  if (envDir.trim()) {
    return path.isAbsolute(envDir.trim()) ? envDir.trim() : path.join(os.homedir(), ".gemini", envDir.trim());
  }
  const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
  if (fs.existsSync(cliDir)) return cliDir;
  const ideDir = path.join(os.homedir(), ".gemini", "antigravity");
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
  const osTmp = normalizeFsPath(os.tmpdir());
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
  return path.posix.basename(slashNorm) || trimmed;
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
    const base = path.posix.basename(norm);
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
  const base = path.posix.basename(nw);
  return base === fw || nw.endsWith(`/${fw}`) || nw.includes(`/${fw}/`);
}
function parseSessionIdList(spec) {
  if (!spec) return [];
  const rawItems = Array.isArray(spec) ? spec : String(spec).split(",");
  return rawItems.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean);
}
function matchesSessionId(sessionId, filterSpec) {
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
    subagentsDir: path.join(systemDir, "subagents")
  };
}
function listSessionArtifactFiles(brainDir, { includeMeta = true } = {}) {
  try {
    const names = fs.readdirSync(brainDir).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    return names.map((name) => {
      const filePath = path.join(brainDir, name);
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
  const brainRoot = path.join(dataDir, "brain");
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
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  const walPath = `${dbPath}-wal`;
  const brainRoot = path.join(dataDir, "brain");
  return `${statSignature(dbPath)}|${statSignature(walPath)}|${statSignature(brainRoot)}`;
}
function loadSessionCatalog(dataDir = resolveDataDir()) {
  const resolvedDir = path.resolve(dataDir);
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
  const dbPath = path.join(resolvedDir, "conversation_summaries.db");
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
function getNotesPath(dataDir = resolveDataDir()) {
  return path2.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}
function loadNotes(dataDir = resolveDataDir()) {
  const filePath = getNotesPath(dataDir);
  if (!fs2.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs2.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch {
    return [];
  }
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
  const notes = loadNotes(dataDir).filter((n) => noteWorkspaceMatches(n.workspace, primaryWs)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 5);
  if (recent.length === 0 && notes.length === 0 && !currentId) {
    return "";
  }
  const lines = ["[agy-memory] Local cross-conversation context (read-only snapshot):"];
  if (currentId) {
    const shortCur = currentId.slice(0, 8);
    lines.push(`Current session: ${shortCur} (pass excludeSessionId="${shortCur}" when searching past sessions)`);
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
      const clip = text.length > 180 ? `${safeSliceChars(text, 179)}\u2026` : text;
      const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
      lines.push(`- [${n.id}] ${n.topic}${tagPart}: ${clip}`);
    }
  }
  lines.push(
    'Use mcp_agy-memory_memory_search_sessions / mcp_agy-memory_memory_read_session(mode="digest") when past session details are needed.'
  );
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
