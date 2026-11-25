#!/usr/bin/env node
// agy-memory MCP Stdio Server & CLI (bundled zero-dependency ESM)


// src/analytics.ts
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
var MAX_DOC_CACHE_ENTRIES = 64;
var VALID_READ_MODES = /* @__PURE__ */ new Set(["digest", "turns", "artifacts", "swarm"]);
var catalogCache = /* @__PURE__ */ new Map();
var turnsCache = /* @__PURE__ */ new Map();
var fullStepsCache = /* @__PURE__ */ new Map();
var searchDocCache = /* @__PURE__ */ new Map();
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
function clampMaxChars(rawVal, fallback = 8200, minVal = 200, maxVal = 8200) {
  if (rawVal === void 0 || rawVal === null || rawVal === "") return fallback;
  const num = Number(rawVal);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(minVal, Math.min(maxVal, Math.floor(num)));
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
function formatShortDate(ms) {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
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
function parseQueryTokens(rawQuery) {
  const text = String(rawQuery || "").trim();
  if (!text) return [];
  const terms = [];
  const seen = /* @__PURE__ */ new Set();
  const tokenRe = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    let tok = "";
    if (match[1] !== void 0) {
      tok = match[1].trim();
    } else if (match[2] !== void 0) {
      tok = match[2].trim();
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
function resolveSessionEntry(dataDir, sessionRef, catalog = null) {
  const ref = String(sessionRef || "").trim().toLowerCase();
  if (!ref) return { entry: null, error: "sessionId is required." };
  const list = catalog || loadSessionCatalog(dataDir);
  const exact = list.find((s) => s.sessionId.toLowerCase() === ref);
  if (exact) return { entry: exact, error: null };
  if (ref.length < 4) {
    return { entry: null, error: `Session prefix "${sessionRef}" is too short (use at least 4 characters).` };
  }
  const matches = list.filter((s) => s.sessionId.toLowerCase().startsWith(ref));
  if (matches.length === 1) return { entry: matches[0], error: null };
  if (matches.length > 1) {
    const listStr = matches.slice(0, 5).map((m) => `${m.shortId} (${m.title || "untitled"})`).join(", ");
    return { entry: null, error: `Ambiguous session prefix "${sessionRef}"; matches: ${listStr}` };
  }
  return { entry: null, error: `No local conversation found matching "${sessionRef}".` };
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
function parseSwarmBoardMessages(swarmBoardPath) {
  if (!swarmBoardPath || !fs.existsSync(swarmBoardPath)) return [];
  let raw = "";
  try {
    raw = fs.readFileSync(swarmBoardPath, "utf8");
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      messages.push({
        seq: typeof msg.seq === "number" ? msg.seq : messages.length + 1,
        time: String(msg.time ?? ""),
        agent: String(msg.agent ?? "?"),
        kind: String(msg.kind ?? ""),
        text: String(msg.text ?? "").trim()
      });
    } catch {
    }
  }
  return messages;
}
function extractSwarmBoardAgents(messages) {
  const agents = /* @__PURE__ */ new Set();
  for (const msg of messages) {
    if (msg.agent && msg.agent !== "?") agents.add(msg.agent);
    if (msg.kind === "brief") {
      const m = /^@([a-z0-9][a-z0-9_-]{0,24})\b/i.exec(msg.text);
      if (m && m[1] && m[1].toLowerCase() !== "all") agents.add(m[1]);
    }
  }
  return [...agents];
}
function splitFileLines(content) {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
function getSearchableSessionDoc(entry, { includeFullTranscript = true } = {}) {
  const cacheKey = `${entry.paths.brainDir}`;
  const transcriptSig = entry.hasTranscript ? statSignature(entry.paths.transcriptPath) : "none";
  const fullSig = includeFullTranscript && entry.hasTranscript && fs.existsSync(entry.paths.transcriptFullPath) ? statSignature(entry.paths.transcriptFullPath) : "none";
  const boardSig = entry.hasSwarm ? statSignature(entry.paths.swarmBoardPath) : "none";
  const artifactsMeta = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: false });
  const artSig = artifactsMeta.map((a) => `${a.name}:${Math.floor(a.updatedAt)}:${a.size}`).join(",");
  const combinedSig = `${transcriptSig}|${fullSig}|${boardSig}|${artSig}`;
  const cached = searchDocCache.get(cacheKey);
  if (cached && cached.sig === combinedSig) {
    return cached.doc;
  }
  const messages = [];
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
      transcriptFullPath: entry.paths.transcriptFullPath
    });
    for (const turn of turns) {
      if (turn.userText) {
        messages.push({
          stepIndex: turn.userStepIndex >= 0 ? turn.userStepIndex : turn.startStep,
          role: "user",
          date: formatShortDate(parseAgyTimestamp(turn.createdAt)),
          text: turn.userText,
          lowText: turn.userText.toLowerCase()
        });
      }
      for (const resp of turn.assistantResponses) {
        if (!resp.text) continue;
        messages.push({
          stepIndex: resp.stepIndex,
          role: "assistant",
          date: formatShortDate(parseAgyTimestamp(resp.createdAt)),
          text: resp.text,
          lowText: resp.text.toLowerCase()
        });
      }
    }
    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      if (lastTurn.userText && lastTurn.assistantResponses.length === 0) {
        inFlightUserStepIndex = lastTurn.userStepIndex >= 0 ? lastTurn.userStepIndex : lastTurn.startStep;
      }
    }
  }
  const artifacts = [];
  for (const art of artifactsMeta) {
    try {
      const content = fs.readFileSync(art.path, "utf8");
      const lineCount = splitFileLines(content).length;
      const combined = `${art.name}
${content}`;
      artifacts.push({
        name: art.name,
        path: art.path,
        updatedAt: art.updatedAt,
        lineCount,
        content,
        lowCombined: combined.toLowerCase()
      });
    } catch {
    }
  }
  const board = entry.hasSwarm ? parseSwarmBoardMessages(entry.paths.swarmBoardPath).map((msg) => ({
    ...msg,
    date: msg.time.slice(5, 16),
    lowText: `${msg.agent} ${msg.text}`.toLowerCase()
  })) : [];
  const doc = {
    messages,
    artifacts,
    board,
    latestTranscriptMtimeMs,
    inFlightUserStepIndex
  };
  lruSet(searchDocCache, cacheKey, { sig: combinedSig, doc }, MAX_DOC_CACHE_ENTRIES);
  return doc;
}
function isSessionDocCached(entry) {
  return searchDocCache.has(entry.paths.brainDir);
}
function summarizeToolCounts(tools, maxDistinct = 4) {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const counts = /* @__PURE__ */ new Map();
  for (const tc of tools) {
    counts.set(tc.name, (counts.get(tc.name) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, maxDistinct).map(([name, count]) => count > 1 ? `${name}\xD7${count}` : name);
  const extra = sorted.length > maxDistinct ? `, +${sorted.length - maxDistinct} more` : "";
  return `${shown.join(", ")}${extra}`;
}
function listSessionsResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    workspace = "",
    query = "",
    includeChildren = false,
    excludeSessionId = "",
    sinceHours = 0,
    minSteps = 0,
    limit = 15,
    maxChars = 8200
  } = opts;
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const safeMinSteps = Math.max(0, Number(minSteps) || 0);
  const catalog = loadSessionCatalog(dataDir);
  const now = Date.now();
  const minMs = sinceHours > 0 ? now - sinceHours * 3600 * 1e3 : 0;
  const queryTerms = parseQueryTokens(query);
  const filtered = [];
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
    ""
  ];
  for (const s of filtered) {
    const snippet = s.lastPrompt || (s.hasTranscript ? readLastUserPromptSnippet(s.paths.transcriptPath, 120, { preferSubstantive: true }) : "");
    const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
    const wsName = s.workspaces.length > 0 ? s.workspaces[0] ?? "" : "";
    const wsLabel = wsName ? formatWorkspaceLabel(wsName) : "";
    const badges = [];
    if (s.hasSwarm) badges.push("swarm");
    if (artifacts.length > 0) badges.push(`${artifacts.length} artifacts`);
    if (s.isChild) badges.push("child");
    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const title = s.title || "(untitled)";
    const meta = [
      formatShortDate(s.updatedMs),
      formatRelativeTime(s.updatedMs, now),
      wsLabel,
      s.stepCount > 0 ? `${s.stepCount} steps` : ""
    ].filter(Boolean).join(" \xB7 ");
    lines.push(`- **${s.shortId}** (${s.sessionId}) \u2014 ${title}${badgeStr}`);
    lines.push(`  ${meta}`);
    if (snippet) {
      lines.push(`  Last user: ${snippet}`);
    }
  }
  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}
function formatSwarmMode(entry, {
  tailMessages = 20,
  startSeq = null,
  endSeq = null,
  query = "",
  safeMaxChars = 8200
}) {
  if (!entry.hasSwarm) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no Swarm data.`,
      isError: false
    };
  }
  const headerLines = [`Swarm for ${entry.shortId} (${entry.title || "untitled"}):`];
  let membersLoaded = false;
  try {
    const membersObj = JSON.parse(fs.readFileSync(entry.paths.swarmMembersPath, "utf8"));
    if (membersObj?.title) headerLines.push(`Title: ${membersObj.title}`);
    const roster = Object.entries(membersObj?.members || {}).map(
      ([name, info]) => `${name} (${info.role || "worker"}, ${info.phase || "unknown"}${info.applied_model || info.model ? `, ${info.applied_model || info.model}` : ""})`
    );
    if (roster.length > 0) {
      headerLines.push(`Members (${roster.length}): ${roster.join(" | ")}`);
      membersLoaded = true;
    }
  } catch {
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
  const firstAll = allMessages[0];
  const lastAll = allMessages[allMessages.length - 1];
  if (matched.length === 0) {
    headerLines.push(
      `No board messages matched filter (board range: #${firstAll.seq}-#${lastAll.seq}, ${allMessages.length} total messages).`
    );
    return { text: truncateUtf8(headerLines.join("\n"), safeMaxChars), isError: false };
  }
  const limitMsgs = Math.max(1, Math.min(100, Number(tailMessages) || 20));
  const forwardFromStart = hasStartSeq && !hasEndSeq;
  const candidateSlice = forwardFromStart ? matched.slice(0, limitMsgs) : matched.slice(-limitMsgs);
  const bodyClipLen = candidateSlice.length <= 4 ? 1400 : candidateSlice.length <= 12 ? 520 : 320;
  const formatMsgBlock = (msg) => {
    const body = msg.text;
    const clipped = body.length > bodyClipLen ? `${safeSliceChars(body, bodyClipLen - 1)}\u2026` : body;
    return `
[#${msg.seq} ${msg.time || ""} \xB7 ${msg.agent}${msg.kind ? ` (${msg.kind})` : ""}]
${clipped}`;
  };
  const reserveForSummaryAndFooter = 240;
  const headerText = headerLines.join("\n");
  const maxBodyChars = Math.max(400, safeMaxChars - headerText.length - reserveForSummaryAndFooter);
  const maxBodyBytes = Math.max(400, 8650 - Buffer.byteLength(headerText, "utf8") - reserveForSummaryAndFooter);
  const chosen = [];
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
    for (let i = candidateSlice.length - 1; i >= 0; i -= 1) {
      const msg = candidateSlice[i];
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
  const firstShownSeq = chosen[0].msg.seq;
  const lastShownSeq = chosen[chosen.length - 1].msg.seq;
  const filterNote = queryTerms.length > 0 ? `, query="${query}"` : "";
  const orderNote = forwardFromStart ? "" : "; newest preserved";
  const out = [
    headerText,
    "",
    `Board messages (showing #${firstShownSeq}-#${lastShownSeq}, ${chosen.length} of ${matched.length} matching / ${allMessages.length} total${filterNote}${orderNote}):`
  ];
  for (const item of chosen) {
    out.push(item.block);
  }
  if (chosen.length < allMessages.length) {
    out.push(
      `
Tip: board spans #${firstAll.seq}-#${lastAll.seq}. Pass startSeq/endSeq or query to inspect specific messages without truncation.`
    );
  }
  return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
}
function formatArtifactsMode(entry, artifacts, {
  artifactName = "",
  startLine = 1,
  endLine = 180,
  safeMaxChars = 8200
}) {
  if (artifacts.length === 0) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no Markdown artifacts.`,
      isError: false
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
      }
      out.push(`- ${a.name} (${lineCount} lines, ${a.size} B) \u2014 Path: ${a.path}`);
      if (a.summary) out.push(`  ${(a.summary.split("\n")[0] ?? "").slice(0, 180)}`);
    }
    out.push(
      "\nTip: For full reads of large Markdown artifacts (>100 lines), call built-in read_file(Path) directly (46 KB inline) or pass artifactName + startLine/endLine."
    );
    return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
  }
  const target = artifacts.find(
    (a) => a.name.toLowerCase() === artifactName.toLowerCase() || a.name.toLowerCase().includes(artifactName.toLowerCase())
  );
  if (!target) {
    return {
      text: `Error: Artifact "${artifactName}" not found in ${entry.shortId}. Available: ${artifacts.map((a) => a.name).join(", ")}`,
      isError: true
    };
  }
  const allLines = splitFileLines(fs.readFileSync(target.path, "utf8"));
  const totalLines = allLines.length;
  const sLine = Math.max(1, Math.floor(Number(startLine) || 1));
  if (sLine > totalLines) {
    return {
      text: `Error: Artifact ${target.name} has only ${totalLines} lines (requested startLine=${sLine}). Path: ${target.path}`,
      isError: true
    };
  }
  const requestedEnd = endLine !== void 0 && endLine !== null && Number.isFinite(Number(endLine)) ? Math.floor(Number(endLine)) : sLine + 179;
  const eLine = Math.min(totalLines, Math.max(sLine, requestedEnd));
  const headerReserve = 280 + target.path.length;
  const maxBodyChars = Math.max(200, safeMaxChars - headerReserve);
  const maxBodyBytes = Math.max(200, 8650 - headerReserve);
  const renderedLines = [];
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
  const header = `Artifact ${target.name} (${entry.shortId}, showing lines ${sLine}-${actualEndLine} of ${totalLines}${truncatedByBudget ? `; budget-truncated at line ${actualEndLine}` : ""}):
Path: ${target.path}`;
  const footer = actualEndLine < totalLines ? `

\u2026 [lines ${actualEndLine + 1}-${totalLines} not shown; use built-in read_file("${target.path}", StartLine=${actualEndLine + 1}, EndLine=${totalLines}) or startLine=${actualEndLine + 1}]` : "";
  return {
    text: truncateUtf8(`${header}

${renderedLines.join("\n")}${footer}`, safeMaxChars),
    isError: false
  };
}
function readSessionResult(opts = {}) {
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
    maxChars = 8200
  } = opts;
  const safeMode = String(mode || "digest").trim().toLowerCase();
  if (!VALID_READ_MODES.has(safeMode)) {
    return {
      text: `Error: Invalid mode "${mode}". Expected one of: digest, turns, artifacts, swarm.`,
      isError: true
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
    transcriptFullPath: entry.paths.transcriptFullPath
  });
  if (turns.length === 0) {
    return {
      text: `Session ${entry.shortId} (${entry.title || "untitled"}) has no readable transcript turns yet.`,
      isError: false
    };
  }
  const firstStep = turns[0].startStep;
  const lastStep = turns[turns.length - 1].endStep;
  const headerLines = [
    `Session: ${entry.sessionId}`,
    `Title: ${entry.title || "(untitled)"}`,
    `Workspace: ${wsStr}`,
    `Updated: ${formatShortDate(entry.updatedMs)} (${formatRelativeTime(entry.updatedMs)}) \xB7 Turns: ${turns.length} \xB7 Steps: #${firstStep}-#${lastStep} (${entry.stepCount || lastStep + 1} total)`
  ];
  if (artifacts.length > 0) {
    const artSummary = artifacts.map((a) => `${a.name} (${a.path})`).join(", ");
    headerLines.push(`Artifacts (${artifacts.length}): ${artSummary}`);
  }
  if (entry.hasSwarm) {
    try {
      const m = JSON.parse(fs.readFileSync(entry.paths.swarmMembersPath, "utf8"));
      const names = Object.keys(m?.members || {}).filter((n) => n !== "coordinator");
      headerLines.push(`Swarm: "${m?.title || ""}" (${names.length} workers: ${names.slice(0, 8).join(", ")})`);
    } catch {
      const boardMsgs = parseSwarmBoardMessages(entry.paths.swarmBoardPath);
      const agents = extractSwarmBoardAgents(boardMsgs).filter((n) => n !== "coordinator");
      if (boardMsgs.length > 0) {
        headerLines.push(
          `Swarm: ${boardMsgs.length} board msgs (#${boardMsgs[0].seq}-#${boardMsgs[boardMsgs.length - 1].seq}; agents: ${agents.slice(0, 8).join(", ")}) \u2014 use mode="swarm"`
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
    const formatDigestTurn = (t) => {
      const userOneLine = t.userText.replace(/\s+/g, " ").trim();
      const userClip = userOneLine.length > userLimit ? `${safeSliceChars(userOneLine, userLimit - 1)}\u2026` : userOneLine;
      const ansClean = t.finalAssistantText.replace(/\s+/g, " ").trim();
      let ansLine = "";
      if (ansClean) {
        ansLine = ansClean.length > ansLimit ? `${safeSliceChars(ansClean, ansLimit - 1)}\u2026` : ansClean;
      } else if (t.tools.length > 0) {
        ansLine = `[no final reply; tools: ${summarizeToolCounts(t.tools)}]`;
      }
      const toolTag = t.tools.length > 0 ? ` [${t.tools.length} tools]` : "";
      const timeTag = t.createdAt ? ` ${formatShortDate(parseAgyTimestamp(t.createdAt))}` : "";
      const block = [`
Turn ${t.turnIndex} (#${t.startStep}-${t.endStep}${timeTag})${toolTag}:`];
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
      const pickedIndices = /* @__PURE__ */ new Set();
      for (let i = 0; i < headCount; i += 1) pickedIndices.add(i);
      for (let i = turns.length - tailCount; i < turns.length; i += 1) pickedIndices.add(i);
      const baseText = [
        ...out,
        ...[...pickedIndices].sort((a, b) => a - b).map((idx) => formatDigestTurn(turns[idx]))
      ].join("\n");
      const remainingChars = safeMaxChars - baseText.length - 360;
      const remainingBytes = 8650 - Buffer.byteLength(baseText, "utf8") - 360;
      if (remainingChars > 400 && remainingBytes > 400) {
        const middleCandidates = [];
        for (let i = headCount; i < turns.length - tailCount; i += 1) {
          const t = turns[i];
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
          const midStart = turns[prevIdx + 1].startStep;
          const midEnd = turns[idx - 1].endStep;
          out.push(`
\u2026 (${omitted} turn(s) omitted, steps #${midStart}-${midEnd}) \u2026`);
        }
        out.push(formatDigestTurn(turns[idx]));
        prevIdx = idx;
      }
      out.push(
        `
Tip: use search_sessions(sessionId="${entry.shortId}", query="...") to jump to specific topics, or read_session(sessionId="${entry.shortId}", mode="turns", startStep=..., endStep=...).`
      );
    }
    return { text: truncateUtf8(out.join("\n"), safeMaxChars), isError: false };
  }
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
        isError: true
      };
    }
  } else {
    const count = Math.max(1, Math.min(40, Number(tailTurns) || 6));
    selected = turns.slice(-count);
  }
  const bodyLines = [];
  for (const t of selected) {
    const modelTag = t.models.length > 0 ? ` \xB7 ${t.models.join(", ")}` : "";
    const fullTag = t.hydratedFromFull ? " \xB7 full" : "";
    bodyLines.push(`
--- Turn ${t.turnIndex} (#${t.startStep}-${t.endStep}${modelTag}${fullTag}) ---`);
    if (t.userText) bodyLines.push(`User:
${t.userText}`);
    if (includeTools && t.tools.length > 0) {
      bodyLines.push(`Tools: ${summarizeToolCounts(t.tools, 12)}`);
    }
    if (includeThinking && t.thoughts.length > 0) {
      const combined2 = t.thoughts.map((th) => th.text).join("\n---\n");
      bodyLines.push(`Thinking:
${safeSliceChars(combined2, 1200)}${combined2.length > 1200 ? "\u2026" : ""}`);
    }
    if (t.finalAssistantText) {
      bodyLines.push(`Assistant:
${t.finalAssistantText}`);
    } else if (t.tools.length > 0) {
      bodyLines.push(`Assistant: [no final reply; tools: ${summarizeToolCounts(t.tools)}]`);
    }
  }
  const fullBody = bodyLines.join("\n");
  const safeOffset = Math.max(0, Math.floor(Number(charOffset) || 0));
  if (safeOffset > 0 && safeOffset >= fullBody.length) {
    return {
      text: `Error: charOffset=${safeOffset} exceeds total turns body length (${fullBody.length} chars).`,
      isError: true
    };
  }
  const slicedBody = safeOffset > 0 ? fullBody.slice(safeOffset) : fullBody;
  const headerBlock = [
    ...headerLines,
    "",
    `Showing ${selected.length} of ${turns.length} turns${safeOffset > 0 ? ` (charOffset=${safeOffset}/${fullBody.length})` : ""}:`
  ].join("\n");
  const combined = `${headerBlock}
${slicedBody}`;
  if (combined.length <= safeMaxChars && Buffer.byteLength(combined, "utf8") <= 8650) {
    return { text: combined, isError: false };
  }
  const footerPlaceholder = `
\u2026 [truncated; pass charOffset=${safeOffset + safeMaxChars} (of ${fullBody.length}) to read more]`;
  const maxContentChars = Math.max(200, safeMaxChars - headerBlock.length - 1 - footerPlaceholder.length - 12);
  const maxContentBytes = Math.max(
    200,
    8650 - Buffer.byteLength(headerBlock, "utf8") - 1 - Buffer.byteLength(footerPlaceholder, "utf8") - 12
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
  const footer = `
\u2026 [truncated; pass charOffset=${nextOffset} (of ${fullBody.length}) to read more]`;
  return { text: `${headerBlock}
${chunk.trimEnd()}${footer}`, isError: false };
}

// src/analytics.ts
var AGY_MEMORY_TOOL_RE = /^(?:mcp_)?agy-memory_memory_([a-z_]+)$/;
var RAW_BRAIN_SHELL_RE = /(?:\.gemini[\\/]+antigravity(?:-cli)?[\\/]+brain|conversation_summaries\.db|transcript(?:_full)?\.jsonl|board\.jsonl)/i;
function parseArgsObj(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function emptyBucket() {
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
      recall_notes: 0
    },
    rawBrainReads: 0,
    mcpSpills: 0,
    budgetTruncations: 0,
    toolErrors: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0
  };
}
function isMemoryToolKey(key) {
  return key === "list_sessions" || key === "search_sessions" || key === "read_session" || key === "save_note" || key === "recall_notes";
}
function analyzeSingleTranscript(transcriptPath) {
  let raw = "";
  try {
    raw = fs2.readFileSync(transcriptPath, "utf8");
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
    let step;
    try {
      step = JSON.parse(trimmed);
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
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
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
      if (content.includes("\u2026 [truncated")) {
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
function mergeBucket(dst, src) {
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
function finalizeBucket(b) {
  const memTotal = b.memoryToolCalls.list_sessions + b.memoryToolCalls.search_sessions + b.memoryToolCalls.read_session + b.memoryToolCalls.save_note + b.memoryToolCalls.recall_notes;
  const estBillableEquiv = Math.round(b.uncachedInputTokens + 0.1 * b.cacheReadTokens + 5 * b.outputTokens);
  const avgTurns = b.sessions > 0 ? Number((b.llmTurns / b.sessions).toFixed(2)) : 0;
  return {
    ...b,
    memoryToolCallsTotal: memTotal,
    avgTurnsPerSession: avgTurns,
    estBillableEquiv
  };
}
function analyzeMemoryUsage(opts = {}) {
  const { dataDir = resolveDataDir(), recent = 50, includeChildren = false } = opts;
  const catalog = loadSessionCatalog(dataDir).filter(
    (entry) => entry.hasTranscript && (includeChildren || !entry.isChild)
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
    dataDir: path2.resolve(dataDir),
    analyzedLimit: limit,
    overall: finalizeBucket(overall),
    withAgyMemory: finalizeBucket(withMemory),
    withoutAgyMemory: finalizeBucket(withoutMemory)
  };
}
function formatMemoryUsageMarkdown(report) {
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
    `| Est. billable equiv tokens | ${o.estBillableEquiv.toLocaleString("en-US")} | ${wo.estBillableEquiv.toLocaleString("en-US")} | ${w.estBillableEquiv.toLocaleString("en-US")} |`
  ];
  return rows.join("\n");
}

// src/notes.ts
import crypto from "node:crypto";
import fs3 from "node:fs";
import path3 from "node:path";
function getNotesPath(dataDir = resolveDataDir()) {
  return path3.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}
function writeJsonAtomic(filePath, data) {
  const dir = path3.dirname(filePath);
  fs3.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}
`;
  try {
    fs3.writeFileSync(tmpPath, payload, {
      encoding: "utf8",
      mode: 384,
      flag: "wx"
    });
    try {
      fs3.renameSync(tmpPath, filePath);
    } catch {
      fs3.copyFileSync(tmpPath, filePath);
      try {
        fs3.unlinkSync(tmpPath);
      } catch {
      }
    }
  } catch (err) {
    try {
      fs3.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
function loadNotes(dataDir = resolveDataDir()) {
  const filePath = getNotesPath(dataDir);
  if (!fs3.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs3.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch {
    return [];
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
function saveNoteResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    id = "",
    deleteId = "",
    topic = "",
    content = "",
    workspace = "",
    tags = [],
    sessionId = ""
  } = opts;
  const filePath = getNotesPath(dataDir);
  const notes = loadNotes(dataDir);
  if (deleteId) {
    const target = String(deleteId).trim();
    const next = notes.filter((n) => n.id !== target);
    if (next.length === notes.length) {
      return { text: `Error: Note "${target}" not found.`, isError: true };
    }
    writeJsonAtomic(filePath, { version: 1, notes: next });
    return {
      text: `Deleted note ${target}. (${next.length} note(s) remaining)`,
      isError: false
    };
  }
  const cleanTopic = String(topic || "").trim();
  const cleanContent = String(content || "").trim();
  if (!cleanTopic || !cleanContent) {
    return {
      text: "Error: both `topic` and `content` are required (or pass `deleteId` to remove a note).",
      isError: true
    };
  }
  const cleanTags = normalizeTagsInput(tags);
  const cleanWs = String(workspace || "").trim();
  const cleanId = String(id || "").trim();
  const now = Date.now();
  const existingIdx = cleanId ? notes.findIndex((n) => n.id === cleanId) : notes.findIndex(
    (n) => String(n.topic || "").toLowerCase() === cleanTopic.toLowerCase() && String(n.workspace || "").toLowerCase() === cleanWs.toLowerCase()
  );
  let saved;
  if (existingIdx >= 0) {
    const existing = notes[existingIdx];
    saved = {
      ...existing,
      topic: cleanTopic,
      content: cleanContent,
      workspace: cleanWs,
      tags: cleanTags.length > 0 ? cleanTags : existing.tags || [],
      sessionId: sessionId || existing.sessionId || "",
      updatedAt: now
    };
    notes[existingIdx] = saved;
  } else {
    saved = {
      id: cleanId || crypto.randomBytes(4).toString("hex"),
      topic: cleanTopic,
      content: cleanContent,
      workspace: cleanWs,
      tags: cleanTags,
      sessionId: String(sessionId || ""),
      createdAt: now,
      updatedAt: now
    };
    notes.push(saved);
  }
  writeJsonAtomic(filePath, { version: 1, notes });
  const verb = existingIdx >= 0 ? "Updated" : "Saved";
  const tagNote = saved.tags.length > 0 ? ` [${saved.tags.join(", ")}]` : "";
  return {
    text: `${verb} note [${saved.id}] "${saved.topic}"${tagNote}${cleanWs ? ` (${cleanWs})` : ""}.`,
    isError: false
  };
}
function recallNotesResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    query = "",
    workspace = "",
    tag = "",
    limit = 15,
    maxChars = 8200
  } = opts;
  const notes = loadNotes(dataDir);
  if (notes.length === 0) {
    return { text: "No saved cross-session notes yet.", isError: false };
  }
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const terms = parseQueryTokens(query);
  const tagFilter = String(tag || "").trim().toLowerCase();
  const filtered = notes.filter((n) => {
    if (workspace && !noteWorkspaceMatches(n.workspace, workspace)) {
      return false;
    }
    if (tagFilter) {
      const nTags = Array.isArray(n.tags) ? n.tags.map((t) => String(t).toLowerCase()) : [];
      if (!nTags.includes(tagFilter)) return false;
    }
    if (terms.length > 0) {
      const hay = `${n.id || ""} ${n.topic || ""} ${n.content || ""} ${(n.tags || []).join(" ")} ${n.workspace || ""}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, safeLimit);
  if (filtered.length === 0) {
    return {
      text: `No saved notes matched your filter (${notes.length} total notes stored).`,
      isError: false
    };
  }
  const now = Date.now();
  const lines = [`Saved cross-session notes (${filtered.length} of ${notes.length}):`];
  for (const n of filtered) {
    const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const wsLabel = n.workspace ? formatWorkspaceLabel(n.workspace) : "";
    const wsPart = wsLabel ? ` \xB7 ${wsLabel}` : "";
    const srcPart = n.sessionId ? ` \xB7 from ${n.sessionId.slice(0, 8)}` : "";
    lines.push(
      `
- **[${n.id}] ${n.topic}**${tagPart} (${formatShortDate(n.updatedAt)}, ${formatRelativeTime(n.updatedAt, now)}${wsPart}${srcPart})`
    );
    lines.push(`  ${n.content}`);
  }
  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

// src/search.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs4 from "node:fs";
var RG_CANDIDATES = process.platform === "win32" ? ["rg", "rg.exe"] : ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
var VALID_SCOPES = /* @__PURE__ */ new Set(["all", "user", "assistant", "artifacts", "swarm"]);
var IN_FLIGHT_WINDOW_MS = 180 * 1e3;
var JSON_ESCAPED_CHAR_RE = /["\\<>&\n\r\t]/;
var LOOKAROUND_RE = /\(\?[=!<]/;
var CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
function parseSearchQuery(rawQuery, isRegex) {
  const text = String(rawQuery || "").trim();
  if (!text) return { terms: [], regex: null, error: "Error: query is required." };
  if (isRegex) {
    try {
      return { terms: [text], regex: new RegExp(text, "i"), error: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        terms: [],
        regex: null,
        error: `Error: Invalid regular expression "${text}": ${msg}`
      };
    }
  }
  const terms = parseQueryTokens(text);
  if (terms.length === 0) {
    return { terms: [], regex: null, error: "Error: query is required." };
  }
  return { terms, regex: null, error: null };
}
function buildCenteredSnippet(text, terms, regex, radius = 95) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  let hitIdx = -1;
  if (regex) {
    const m = regex.exec(clean);
    if (m) hitIdx = m.index;
  } else {
    const low = clean.toLowerCase();
    for (const term of terms) {
      const idx = low.indexOf(term);
      if (idx >= 0 && (hitIdx === -1 || idx < hitIdx)) {
        hitIdx = idx;
      }
    }
  }
  if (hitIdx < 0) {
    return clean.length > radius * 2 ? `${safeSliceChars(clean, radius * 2 - 1)}\u2026` : clean;
  }
  const start = Math.max(0, hitIdx - radius);
  const end = Math.min(clean.length, hitIdx + radius + 35);
  const prefix = start > 0 ? "\u2026" : "";
  const suffix = end < clean.length ? "\u2026" : "";
  let slice = clean.slice(start, end);
  if (slice.length > 0) {
    const firstCode = slice.charCodeAt(0);
    if (firstCode >= 56320 && firstCode <= 57343) {
      slice = slice.slice(1);
    }
  }
  slice = safeSliceChars(slice, slice.length);
  return `${prefix}${slice}${suffix}`;
}
function rankSeedTerms(terms) {
  return [...terms].sort((a, b) => {
    const scoreOf = (term) => {
      const cjkMatches = term.match(CJK_CHAR_RE);
      const cjkCount = cjkMatches ? cjkMatches.length : 0;
      const nonCjkLen = term.length - cjkCount;
      return cjkCount * 3.5 + nonCjkLen;
    };
    return scoreOf(b) - scoreOf(a);
  });
}
function collectEligibleRgFiles(entries, scope) {
  const wantTranscript = scope === "all" || scope === "user" || scope === "assistant";
  const wantArtifacts = scope === "all" || scope === "artifacts";
  const wantSwarm = scope === "all" || scope === "swarm";
  const files = [];
  const fileToSession = /* @__PURE__ */ new Map();
  const registerFile = (filePath, sessionId) => {
    files.push(filePath);
    fileToSession.set(normalizeFsPath(filePath), sessionId);
  };
  for (const entry of entries) {
    if (wantTranscript && entry.hasTranscript) {
      registerFile(entry.paths.transcriptPath, entry.sessionId);
      if (fs4.existsSync(entry.paths.transcriptFullPath)) {
        registerFile(entry.paths.transcriptFullPath, entry.sessionId);
      }
    }
    if (wantArtifacts) {
      const arts = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: false });
      for (const art of arts) {
        registerFile(art.path, entry.sessionId);
      }
    }
    if (wantSwarm && entry.hasSwarm && fs4.existsSync(entry.paths.swarmBoardPath)) {
      registerFile(entry.paths.swarmBoardPath, entry.sessionId);
    }
  }
  return { files, fileToSession };
}
function findMatchingSessionsWithRg(entries, pattern, isRegex, scope) {
  const { files, fileToSession } = collectEligibleRgFiles(entries, scope);
  if (files.length === 0) return /* @__PURE__ */ new Set();
  const CHUNK_SIZE = process.platform === "win32" ? 120 : 400;
  const matchedSessions = /* @__PURE__ */ new Set();
  for (let offset = 0; offset < files.length; offset += CHUNK_SIZE) {
    const slice = files.slice(offset, offset + CHUNK_SIZE);
    const args = ["--files-with-matches", "--ignore-case", "--no-messages", "--follow"];
    if (!isRegex) args.push("--fixed-strings");
    args.push("--", pattern, ...slice);
    let chunkDone = false;
    for (const rgBin of RG_CANDIDATES) {
      try {
        const stdout = execFileSync2(rgBin, args, {
          encoding: "utf8",
          timeout: 4e3,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"]
        });
        for (const line of stdout.split(/\r?\n/)) {
          const hitFile = line.trim();
          if (!hitFile) continue;
          const sid = fileToSession.get(normalizeFsPath(hitFile));
          if (sid) matchedSessions.add(sid);
        }
        chunkDone = true;
        break;
      } catch (err) {
        const status = err?.status;
        if (typeof status === "number" && status === 1) {
          chunkDone = true;
          break;
        }
      }
    }
    if (!chunkDone) return null;
  }
  return matchedSessions;
}
function matchLowerOrRegex(lowText, origText, terms, regex) {
  if (!origText) return { matchedAny: false, matchedAll: false, hitTerms: /* @__PURE__ */ new Set() };
  if (regex) {
    const ok = regex.test(origText);
    return { matchedAny: ok, matchedAll: ok, hitTerms: ok ? /* @__PURE__ */ new Set(["__re__"]) : /* @__PURE__ */ new Set() };
  }
  const hitTerms = /* @__PURE__ */ new Set();
  for (const term of terms) {
    if (lowText.includes(term)) hitTerms.add(term);
  }
  return {
    matchedAny: hitTerms.size > 0,
    matchedAll: hitTerms.size === terms.length,
    hitTerms
  };
}
function selectDiverseSnippets(candidates, terms, maxSnippets) {
  if (candidates.length <= maxSnippets) {
    return [...candidates].sort((a, b) => b.score - a.score || b.stepIndex - a.stepIndex);
  }
  const remaining = [...candidates];
  const selected = [];
  const coveredTerms = /* @__PURE__ */ new Set();
  while (selected.length < maxSnippets && remaining.length > 0) {
    let bestIdx = 0;
    let bestEffective = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i];
      let effective = cand.score;
      if (selected.length > 0 && terms.length > 1) {
        let newTerms = 0;
        for (const t of cand.hitTerms) {
          if (!coveredTerms.has(t)) newTerms += 1;
        }
        effective += newTerms * 4.5;
      }
      if (selected.length > 0) {
        const nearExisting = selected.some(
          (picked) => picked.role === cand.role && picked.stepIndex >= 0 && cand.stepIndex >= 0 && Math.abs(picked.stepIndex - cand.stepIndex) <= 12
        );
        if (nearExisting) {
          effective -= 2;
        }
        const distinctSource = selected.every((picked) => picked.sourceKind !== cand.sourceKind);
        if (distinctSource) {
          effective += 1.2;
        }
      }
      if (effective > bestEffective || effective === bestEffective && cand.stepIndex > remaining[bestIdx].stepIndex) {
        bestEffective = effective;
        bestIdx = i;
      }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push(chosen);
    for (const t of chosen.hitTerms) coveredTerms.add(t);
  }
  return selected;
}
function scanSessionDoc(entry, {
  scope,
  terms,
  regex,
  maxSnippets,
  now,
  skipInFlightSelfPrompt
}) {
  const sessionTermsFound = /* @__PURE__ */ new Set();
  const candidates = [];
  let titleMatched = false;
  let titleHitCount = 0;
  let skippedInFlight = false;
  if (scope === "all") {
    const titleText = `${entry.title} ${entry.preview}`.trim();
    const titleCheck = matchLowerOrRegex(titleText.toLowerCase(), titleText, terms, regex);
    if (titleCheck.matchedAny) {
      titleMatched = true;
      titleHitCount = titleCheck.hitTerms.size;
      for (const t of titleCheck.hitTerms) sessionTermsFound.add(t);
    }
  }
  const doc = getSearchableSessionDoc(entry, { includeFullTranscript: true });
  const isRecentlyActive = doc.latestTranscriptMtimeMs > 0 && now - doc.latestTranscriptMtimeMs < IN_FLIGHT_WINDOW_MS;
  const wantTranscript = scope === "all" || scope === "user" || scope === "assistant";
  const wantArtifacts = scope === "all" || scope === "artifacts";
  const wantSwarm = scope === "all" || scope === "swarm";
  if (wantTranscript && doc.messages.length > 0) {
    for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
      const msg = doc.messages[i];
      if (scope === "user" && msg.role !== "user") continue;
      if (scope === "assistant" && msg.role !== "assistant") continue;
      if (skipInFlightSelfPrompt && isRecentlyActive && msg.role === "user" && msg.stepIndex === doc.inFlightUserStepIndex) {
        skippedInFlight = true;
        continue;
      }
      const check = matchLowerOrRegex(msg.lowText, msg.text, terms, regex);
      if (!check.matchedAny) continue;
      for (const t of check.hitTerms) sessionTermsFound.add(t);
      const baseScore = (check.matchedAll ? 6 : 1.5 * check.hitTerms.size) + (msg.role === "user" ? 1 : 0.5);
      candidates.push({
        score: baseScore,
        stepIndex: msg.stepIndex,
        role: msg.role,
        sourceKind: msg.role,
        date: msg.date,
        hitTerms: check.hitTerms,
        excerpt: buildCenteredSnippet(msg.text, terms, regex)
      });
    }
  }
  if (wantArtifacts && doc.artifacts.length > 0) {
    for (const art of doc.artifacts) {
      const check = matchLowerOrRegex(art.lowCombined, `${art.name}
${art.content}`, terms, regex);
      if (!check.matchedAny) continue;
      for (const t of check.hitTerms) sessionTermsFound.add(t);
      const baseScore = (check.matchedAll ? 7 : 2 * check.hitTerms.size) + 1.5;
      candidates.push({
        score: baseScore,
        stepIndex: -1,
        role: `artifact:${art.name}`,
        sourceKind: "artifact",
        artifactPath: art.path,
        artifactLines: art.lineCount,
        date: formatShortDate(art.updatedAt),
        hitTerms: check.hitTerms,
        excerpt: buildCenteredSnippet(art.content, terms, regex)
      });
    }
  }
  if (wantSwarm && doc.board.length > 0) {
    for (let i = doc.board.length - 1; i >= 0; i -= 1) {
      const msg = doc.board[i];
      const check = matchLowerOrRegex(msg.lowText, `${msg.agent} ${msg.text}`, terms, regex);
      if (!check.matchedAny) continue;
      for (const t of check.hitTerms) sessionTermsFound.add(t);
      const baseScore = (check.matchedAll ? 6.5 : 1.5 * check.hitTerms.size) + 1;
      candidates.push({
        score: baseScore,
        stepIndex: msg.seq,
        role: `swarm:${msg.agent}`,
        sourceKind: "swarm",
        date: msg.date,
        hitTerms: check.hitTerms,
        excerpt: buildCenteredSnippet(msg.text, terms, regex)
      });
    }
  }
  const requiredCount = regex ? 1 : terms.length;
  if (sessionTermsFound.size < requiredCount) {
    return { hit: null, skippedInFlight };
  }
  const topSnippets = selectDiverseSnippets(candidates, terms, maxSnippets);
  const titleScore = scope === "all" && titleMatched ? Math.round(10 * (titleHitCount / requiredCount)) : 0;
  const snippetScore = topSnippets.reduce((acc, s) => acc + s.score, 0);
  const hitBonus = Math.min(8, Math.log2(1 + candidates.length) * 2.5);
  const ageDays = entry.updatedMs > 0 ? Math.max(0, (now - entry.updatedMs) / (24 * 3600 * 1e3)) : 30;
  const recencyBonus = 8 / (1 + ageDays / 1.5);
  const tinyUntitledPenalty = !entry.title && entry.stepCount > 0 && entry.stepCount <= 5 ? -6 : 0;
  const score = titleScore + snippetScore + hitBonus + recencyBonus + tinyUntitledPenalty;
  return {
    hit: {
      entry,
      score,
      totalHits: candidates.length,
      titleMatched,
      snippets: topSnippets
    },
    skippedInFlight
  };
}
function searchSessionsResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    query = "",
    scope = "all",
    regex: isRegex = false,
    workspace = "",
    sessionId = "",
    includeChildren = false,
    excludeSessionId = "",
    sinceDays = 0,
    maxSessions = 10,
    maxSnippetsPerSession = 3,
    maxChars = 8200
  } = opts;
  const safeScope = String(scope || "all").trim().toLowerCase();
  if (!VALID_SCOPES.has(safeScope)) {
    return {
      text: `Error: Invalid scope "${scope}". Expected one of: all, user, assistant, artifacts, swarm.`,
      isError: true
    };
  }
  const parsed = parseSearchQuery(query, Boolean(isRegex));
  if (parsed.error) {
    return { text: parsed.error, isError: true };
  }
  const { terms, regex } = parsed;
  const safeMaxSessions = Math.max(1, Math.min(25, Number(maxSessions) || 10));
  const safeMaxSnippets = Math.max(1, Math.min(8, Number(maxSnippetsPerSession) || 3));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const catalog = loadSessionCatalog(dataDir);
  const now = Date.now();
  const minMs = sinceDays > 0 ? now - sinceDays * 24 * 3600 * 1e3 : 0;
  const targetSessionRef = String(sessionId || "").trim();
  const eligible = catalog.filter((s) => {
    if (!includeChildren && !targetSessionRef && s.isChild) return false;
    if (targetSessionRef && !matchesSessionId(s.sessionId, targetSessionRef)) return false;
    if (excludeSessionId && matchesSessionId(s.sessionId, excludeSessionId)) return false;
    if (minMs > 0 && s.updatedMs < minMs) return false;
    if (!workspaceMatches(s.workspaces, workspace)) return false;
    return true;
  });
  if (targetSessionRef && eligible.length === 0) {
    return {
      text: `Error: No local conversation found matching sessionId "${targetSessionRef}".`,
      isError: true
    };
  }
  const hasJsonSpecial = terms.some((t) => JSON_ESCAPED_CHAR_RE.test(t));
  const hasLookaround = Boolean(regex) && LOOKAROUND_RE.test(String(query));
  const uncachedEntries = eligible.filter((s) => !isSessionDocCached(s));
  let toScan = eligible;
  if (!targetSessionRef && uncachedEntries.length > 0 && !hasJsonSpecial && !hasLookaround) {
    let remainingUncached = uncachedEntries;
    const seedList = regex ? [String(query)] : rankSeedTerms(terms).slice(0, 3);
    let rgFailed = false;
    for (const seedTerm of seedList) {
      if (remainingUncached.length === 0) break;
      const rgMatchedIds = findMatchingSessionsWithRg(remainingUncached, seedTerm, Boolean(regex), safeScope);
      if (!(rgMatchedIds instanceof Set)) {
        rgFailed = true;
        break;
      }
      remainingUncached = remainingUncached.filter((s) => {
        if (rgMatchedIds.has(s.sessionId)) return true;
        if (safeScope === "all") {
          const titleText = `${s.title} ${s.preview}`.trim();
          const lowTitle = titleText.toLowerCase();
          if (regex ? regex.test(titleText) : lowTitle.includes(seedTerm)) {
            return true;
          }
        }
        return false;
      });
      if (remainingUncached.length <= 3) break;
    }
    if (!rgFailed) {
      const keptUncached = new Set(remainingUncached.map((s) => s.sessionId));
      toScan = eligible.filter((s) => isSessionDocCached(s) || keptUncached.has(s.sessionId));
    }
  }
  const skipInFlightSelfPrompt = !targetSessionRef;
  const results = [];
  let skippedInFlightCount = 0;
  for (const entry of toScan) {
    const { hit, skippedInFlight } = scanSessionDoc(entry, {
      scope: safeScope,
      terms,
      regex,
      maxSnippets: safeMaxSnippets,
      now,
      skipInFlightSelfPrompt
    });
    if (skippedInFlight) skippedInFlightCount += 1;
    if (hit) results.push(hit);
  }
  results.sort((a, b) => b.score - a.score || b.entry.updatedMs - a.entry.updatedMs);
  const top = results.slice(0, safeMaxSessions);
  if (top.length === 0) {
    const scopeLabel = safeScope === "all" ? "transcripts, artifacts, and swarm boards" : safeScope;
    const filters = [];
    if (workspace) filters.push(`workspace~"${workspace}"`);
    if (targetSessionRef) filters.push(`sessionId="${targetSessionRef}"`);
    if (skippedInFlightCount > 0) filters.push("excluded active in-flight prompt");
    const filterSuffix = filters.length > 0 ? `; ${filters.join(", ")}` : "";
    return {
      text: `No past conversations matched "${query}" (searched ${eligible.length} session(s) across ${scopeLabel}${filterSuffix}).`,
      isError: false
    };
  }
  const lines = [
    `Search "${query}" \u2014 ${results.length} matching conversation(s) (showing top ${top.length}, scope=${safeScope}${targetSessionRef ? `, session=${targetSessionRef}` : ""}):`
  ];
  for (const r of top) {
    const e = r.entry;
    const wsName = e.workspaces.length > 0 ? formatWorkspaceLabel(e.workspaces[0] ?? "") : "";
    lines.push(
      `
### ${e.shortId} \u2014 ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`
    );
    lines.push(`ID: ${e.sessionId}`);
    if (r.snippets.length === 0 && r.titleMatched) {
      lines.push(`- [title] ${e.title || e.preview}`);
    } else {
      for (const sn of r.snippets) {
        const stepTag = sn.stepIndex >= 0 ? ` #${sn.stepIndex}` : "";
        const dateTag = sn.date ? ` ${sn.date}` : "";
        const artMeta = sn.artifactPath ? ` (${sn.artifactLines ?? 0} lines, Path: ${sn.artifactPath})` : "";
        lines.push(`- [${sn.role}${stepTag}${dateTag}]${artMeta} ${sn.excerpt}`);
      }
    }
  }
  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

// src/tools.ts
var TOOL_DEFINITIONS = [
  {
    name: "list_sessions",
    description: "List recent local Antigravity conversations (titles, IDs, workspaces, step counts, substantive latest prompt, swarm/artifact badges). Fast read-only catalog query, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace path (exact/child match) or folder name filter."
        },
        query: {
          type: "string",
          description: "Optional multi-word filter (supports quoted phrases) matched against title, preview, ID, workspace, and last user message."
        },
        includeChildren: {
          type: "boolean",
          description: "Include subagent and Swarm worker child conversations (default false)."
        },
        excludeSessionId: {
          type: "string",
          description: "Optional conversation ID or prefix (>=4 chars, or comma-separated list) to exclude (e.g. current session)."
        },
        sinceHours: {
          type: "number",
          description: "Optional recency window in hours."
        },
        minSteps: {
          type: "integer",
          description: "Optional minimum step count to filter out tiny/probe sessions (e.g. 5)."
        },
        limit: {
          type: "integer",
          description: "Maximum sessions to return (1..50, default 15)."
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200)."
        }
      }
    }
  },
  {
    name: "search_sessions",
    description: "Search across past local Antigravity conversations (CJK and English supported) covering user prompts, assistant replies (including hydrated full responses), Markdown artifacts, and Swarm boards. Returns ranked, term-diverse excerpts with session IDs, step numbers, and artifact paths.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keywords (multi-word AND, supports quoted phrases) or regex when regex=true."
        },
        scope: {
          type: "string",
          enum: ["all", "user", "assistant", "artifacts", "swarm"],
          description: "Where to search (default 'all'; strictly scoped when not 'all')."
        },
        regex: {
          type: "boolean",
          description: "Treat query as a case-insensitive regular expression (default false)."
        },
        sessionId: {
          type: "string",
          description: "Optional full UUID or prefix (>=4 chars) to search within a single specific conversation."
        },
        workspace: {
          type: "string",
          description: "Optional workspace path (exact/child match) or folder name filter."
        },
        includeChildren: {
          type: "boolean",
          description: "Include subagent/Swarm worker child conversations (default false)."
        },
        excludeSessionId: {
          type: "string",
          description: "Optional conversation ID or prefix (>=4 chars, or comma-separated list) to exclude (e.g. current session)."
        },
        sinceDays: {
          type: "number",
          description: "Optional recency window in days."
        },
        maxSessions: {
          type: "integer",
          description: "Maximum matching conversations to return (1..25, default 10)."
        },
        maxSnippetsPerSession: {
          type: "integer",
          description: "Maximum term-diverse excerpts per conversation (1..8, default 3)."
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200)."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "read_session",
    description: "Read a specific past conversation by full UUID or prefix (>=4 chars). Use mode='digest' first for an overview of turns + artifacts + Swarm summary, then 'turns' (auto-hydrates truncated full replies, supports charOffset), 'artifacts', or 'swarm' (preserves newest messages, supports startSeq/endSeq/query).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Full conversation UUID or unambiguous prefix (e.g. 'a1b2c3d4')."
        },
        mode: {
          type: "string",
          enum: ["digest", "turns", "artifacts", "swarm"],
          description: "View mode (default 'digest')."
        },
        startStep: {
          type: "integer",
          description: "For mode='turns': inclusive starting step index."
        },
        endStep: {
          type: "integer",
          description: "For mode='turns': inclusive ending step index."
        },
        tailTurns: {
          type: "integer",
          description: "For mode='turns' without step bounds: last N turns to show (1..40, default 6)."
        },
        charOffset: {
          type: "integer",
          description: "For mode='turns': starting character offset to continue reading a large >8.2 KB turn."
        },
        includeTools: {
          type: "boolean",
          description: "For mode='turns': include tool call count summary per turn (default false)."
        },
        includeThinking: {
          type: "boolean",
          description: "For mode='turns': include truncated thinking text (default false)."
        },
        artifactName: {
          type: "string",
          description: "For mode='artifacts': specific Markdown artifact filename to read."
        },
        startLine: {
          type: "integer",
          description: "For mode='artifacts' with artifactName: 1-based start line (default 1)."
        },
        endLine: {
          type: "integer",
          description: "For mode='artifacts' with artifactName: 1-based inclusive end line (default 180)."
        },
        tailMessages: {
          type: "integer",
          description: "For mode='swarm': last N board messages to show (1..100, default 20; newest preserved within budget)."
        },
        startSeq: {
          type: "integer",
          description: "For mode='swarm': inclusive starting message sequence number (#seq)."
        },
        endSeq: {
          type: "integer",
          description: "For mode='swarm': inclusive ending message sequence number (#seq)."
        },
        query: {
          type: "string",
          description: "For mode='swarm': optional multi-word AND filter matched against board agent and text."
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200)."
        }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "save_note",
    description: "Save, update, or delete a curated cross-session memory note stored persistently on disk (outside any single conversation). Never store secrets or tokens.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Short descriptive title/topic of the note."
        },
        content: {
          type: "string",
          description: "Concise fact, decision, conclusion, or preference to remember across sessions."
        },
        workspace: {
          type: "string",
          description: "Optional workspace path this note applies to (omit for global notes)."
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for recall filtering."
        },
        sessionId: {
          type: "string",
          description: "Optional source conversation ID."
        },
        id: {
          type: "string",
          description: "Optional existing note ID to update in place."
        },
        deleteId: {
          type: "string",
          description: "If set, deletes the note with this ID instead of saving."
        }
      }
    }
  },
  {
    name: "recall_notes",
    description: "Recall previously saved cross-session memory notes filtered by query (matches ID, topic, content, tags, workspace), workspace, or tag.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional multi-word search query (supports quoted phrases)."
        },
        workspace: {
          type: "string",
          description: "Optional workspace path filter (also keeps global and parent-workspace notes)."
        },
        tag: {
          type: "string",
          description: "Optional exact tag filter."
        },
        limit: {
          type: "integer",
          description: "Maximum notes to return (1..30, default 15)."
        },
        maxChars: {
          type: "integer",
          description: "Output character cap (200..8200, default 8200)."
        }
      }
    }
  }
];
function asString(v) {
  return typeof v === "string" ? v : v === void 0 || v === null ? "" : String(v);
}
function asOptionalNumber(v) {
  if (v === void 0 || v === null || v === "") return void 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : void 0;
}
function executeToolResult(name, rawArgs = {}, opts = {}) {
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
        maxChars: asOptionalNumber(args.maxChars)
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
        maxChars: asOptionalNumber(args.maxChars)
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
        maxChars: asOptionalNumber(args.maxChars)
      });
    case "save_note":
      return saveNoteResult({
        dataDir,
        id: asString(args.id),
        deleteId: asString(args.deleteId),
        topic: asString(args.topic),
        content: asString(args.content),
        workspace: asString(args.workspace),
        tags: Array.isArray(args.tags) ? args.tags : typeof args.tags === "string" ? args.tags : [],
        sessionId: asString(args.sessionId)
      });
    case "recall_notes":
      return recallNotesResult({
        dataDir,
        query: asString(args.query),
        workspace: asString(args.workspace),
        tag: asString(args.tag),
        limit: asOptionalNumber(args.limit),
        maxChars: asOptionalNumber(args.maxChars)
      });
    default:
      return { text: `Error: Unknown tool: ${name}`, isError: true };
  }
}

// src/mcp-server.ts
var SERVER_INFO = {
  name: "agy-memory",
  version: "0.2.0"
};
var SUPPORTED_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25"
]);
var DEFAULT_PROTOCOL_VERSION = "2025-06-18";
function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request"
      }
    };
  }
  const record = msg;
  const hasId = Object.prototype.hasOwnProperty.call(record, "id") && record.id !== void 0;
  const id = hasId ? record.id : null;
  const method = record.method;
  const params = record.params && typeof record.params === "object" && !Array.isArray(record.params) ? record.params : {};
  if (typeof method !== "string" || !method.trim()) {
    return {
      jsonrpc: "2.0",
      id: hasId ? id : null,
      error: {
        code: -32600,
        message: "Invalid Request: missing method"
      }
    };
  }
  if (!hasId || id === null) {
    return null;
  }
  try {
    if (method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: SERVER_INFO
        }
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: TOOL_DEFINITIONS }
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
      const toolArgs = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      const { text, isError } = executeToolResult(toolName, toolArgs);
      const resultPayload = {
        content: [{ type: "text", text }]
      };
      if (isError) {
        resultPayload.isError = true;
      }
      return {
        jsonrpc: "2.0",
        id,
        result: resultPayload
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [{ type: "text", text: `Error: ${errMsg}` }]
      }
    };
  }
}
function findHeaderSeparator(buf) {
  const crlfIdx = buf.indexOf("\r\n\r\n");
  if (crlfIdx !== -1) return { idx: crlfIdx, sepLen: 4 };
  const lfIdx = buf.indexOf("\n\n");
  if (lfIdx !== -1) return { idx: lfIdx, sepLen: 2 };
  return null;
}
function runMcpStdioServer() {
  let rawBuf = Buffer.alloc(0);
  let framingMode = null;
  const writeResponse = (obj) => {
    if (!obj) return;
    const body = JSON.stringify(obj);
    if (framingMode === "lsp") {
      const len = Buffer.byteLength(body, "utf8");
      process.stdout.write(`Content-Length: ${len}\r
\r
${body}`);
    } else {
      process.stdout.write(`${body}
`);
    }
  };
  const writeParseError = () => {
    writeResponse({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error"
      }
    });
  };
  const dispatchParsed = (parsed) => {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        writeResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request: empty batch" }
        });
        return;
      }
      const replies = parsed.map(handleJsonRpcMessage).filter((r) => r !== null);
      if (replies.length > 0) writeResponse(replies);
      return;
    }
    const reply = handleJsonRpcMessage(parsed);
    if (reply) writeResponse(reply);
  };
  const drainBuffer = (isEof = false) => {
    while (rawBuf.length > 0) {
      if (framingMode !== "lsp") {
        let trimStart = 0;
        while (trimStart < rawBuf.length && (rawBuf[trimStart] === 32 || rawBuf[trimStart] === 9 || rawBuf[trimStart] === 13 || rawBuf[trimStart] === 10)) {
          trimStart += 1;
        }
        if (trimStart > 0) rawBuf = rawBuf.subarray(trimStart);
        if (rawBuf.length === 0) return;
      }
      if (!framingMode) {
        if (rawBuf[0] === 123 || rawBuf[0] === 91) {
          framingMode = "jsonl";
        } else {
          const head = rawBuf.subarray(0, 64).toString("ascii");
          if (/^(?:content-length|content-type|[a-z][a-z0-9-]*)\s*:/i.test(head)) {
            framingMode = "lsp";
          } else if (!isEof && rawBuf.length < 32 && rawBuf.indexOf(10) === -1) {
            return;
          } else {
            framingMode = "jsonl";
          }
        }
      }
      if (framingMode === "lsp") {
        let trimStart = 0;
        while (trimStart < rawBuf.length && (rawBuf[trimStart] === 13 || rawBuf[trimStart] === 10)) {
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
        const nlIdx = rawBuf.indexOf(10);
        let lineBuf;
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
  process.stdin.on("data", (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    rawBuf = rawBuf.length === 0 ? buf : Buffer.concat([rawBuf, buf]);
    drainBuffer(false);
  });
  process.stdin.on("end", () => {
    drainBuffer(true);
    if (process.stdout.writable && !process.stdout.writableEnded) {
      process.stdout.end();
    }
  });
}
function parseCliArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] ?? "";
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
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
function parseOptionalInt(val) {
  if (val === void 0 || val === "" || val === true || val === false) return void 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : void 0;
}
function flagString(flags, key) {
  const v = flags[key];
  return typeof v === "string" ? v : "";
}
function runCliMode(argv) {
  const { positional, flags } = parseCliArgs(argv);
  const sub = (positional[0] || "help").toLowerCase();
  const dataDirFlag = flagString(flags, "data-dir");
  const dataDirOpt = dataDirFlag ? { dataDir: dataDirFlag } : {};
  if (sub === "list") {
    const { text, isError } = executeToolResult(
      "list_sessions",
      {
        workspace: flagString(flags, "workspace"),
        query: positional.slice(1).join(" ") || flagString(flags, "query"),
        includeChildren: Boolean(flags["include-children"]),
        excludeSessionId: flagString(flags, "exclude"),
        sinceHours: parseOptionalInt(flags["since-hours"]),
        minSteps: parseOptionalInt(flags["min-steps"]),
        limit: parseOptionalInt(flags.limit),
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      dataDirOpt
    );
    process.stdout.write(`${text}
`);
    if (isError) process.exitCode = 1;
    return;
  }
  if (sub === "search") {
    const query = positional.slice(1).join(" ") || flagString(flags, "query");
    const { text, isError } = executeToolResult(
      "search_sessions",
      {
        query,
        scope: flagString(flags, "scope") || "all",
        regex: Boolean(flags.regex),
        sessionId: flagString(flags, "session"),
        workspace: flagString(flags, "workspace"),
        includeChildren: Boolean(flags["include-children"]),
        excludeSessionId: flagString(flags, "exclude"),
        sinceDays: parseOptionalInt(flags["since-days"]),
        maxSessions: parseOptionalInt(flags.limit),
        maxSnippetsPerSession: parseOptionalInt(flags["max-snippets"]),
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      dataDirOpt
    );
    process.stdout.write(`${text}
`);
    if (isError) process.exitCode = 1;
    return;
  }
  if (sub === "read") {
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
        includeTools: Boolean(flags.tools),
        includeThinking: Boolean(flags.thinking),
        artifactName: flagString(flags, "artifact"),
        startLine: parseOptionalInt(flags["start-line"]),
        endLine: parseOptionalInt(flags["end-line"]),
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      dataDirOpt
    );
    process.stdout.write(`${text}
`);
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
        deleteId: flagString(flags, "delete")
      },
      dataDirOpt
    );
    process.stdout.write(`${text}
`);
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
        limit: parseOptionalInt(flags.limit)
      },
      dataDirOpt
    );
    process.stdout.write(`${text}
`);
    if (isError) process.exitCode = 1;
    return;
  }
  if (sub === "stats" || sub === "benchmark") {
    const report = analyzeMemoryUsage({
      ...dataDirOpt,
      recent: parseOptionalInt(flags.recent) || 50,
      includeChildren: Boolean(flags["include-children"])
    });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
    } else {
      process.stdout.write(`${formatMemoryUsageMarkdown(report)}
`);
    }
    return;
  }
  process.stdout.write(
    [
      `agy-memory v${SERVER_INFO.version} CLI usage:`,
      "  node dist/mcp-server.mjs --cli list [--workspace <dir>] [--min-steps 5] [--exclude <id>] [--limit 15] [query]",
      "  node dist/mcp-server.mjs --cli search [--scope all|user|assistant|artifacts|swarm] [--session <id>] [--exclude <id>] [--workspace <dir>] <query>",
      "  node dist/mcp-server.mjs --cli read <sessionId> [--mode digest|turns|artifacts|swarm] [--tail 20] [--start-seq N] [--end-seq N] [--query <q>] [--char-offset N]",
      "  node dist/mcp-server.mjs --cli note-save --topic <title> --content <text> [--workspace <dir>] [--tags a,b]",
      "  node dist/mcp-server.mjs --cli note-recall [query] [--workspace <dir>] [--tag <tag>]",
      "  node dist/mcp-server.mjs --cli stats [--recent 50] [--json]"
    ].join("\n") + "\n"
  );
}
var cliFlagIdx = process.argv.indexOf("--cli");
if (cliFlagIdx >= 0) {
  runCliMode(process.argv.slice(cliFlagIdx + 1));
} else {
  runMcpStdioServer();
}
