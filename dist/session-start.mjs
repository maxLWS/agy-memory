// agy-memory SessionStart Hook (bundled zero-dependency ESM)


// src/board.ts
import crypto2 from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";

// src/scope.ts
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
var DEFAULT_PROJECT_SENTINELS = /* @__PURE__ */ new Set(["default-cli-project"]);
var CONVERSATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
var PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
var MAX_TRAJECTORY_BLOB_BYTES = 2 * 1024 * 1024;
var DEFAULT_BUSY_TIMEOUT_MS = 1e3;
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
function getBusyTimeoutMs() {
  const raw = Number(process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 50 && raw <= 3e4) {
    return Math.floor(raw);
  }
  return DEFAULT_BUSY_TIMEOUT_MS;
}
function getGeminiHome() {
  const envHome = (process.env.GEMINI_HOME || "").trim();
  if (envHome) return path.resolve(envHome);
  return path.join(os.homedir(), ".gemini");
}
function resolveBoardsHome(overrideHome = "") {
  if (overrideHome && overrideHome.trim()) return path.resolve(overrideHome.trim());
  const envHome = (process.env.AGY_MEMORY_HOME || "").trim();
  if (envHome) return path.resolve(envHome);
  return path.join(getGeminiHome(), "agy-memory");
}
function classifyClientDir(dirPath) {
  const base = path.basename(path.resolve(dirPath)).toLowerCase();
  if (base === "antigravity") return "app";
  if (base === "antigravity-cli") return "cli";
  if (base === "antigravity-ide") return "ide";
  return "custom";
}
function discoverClientDataDirs(overrideDir = "") {
  const explicit = (overrideDir || "").trim() || (process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "").trim();
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? path.resolve(explicit) : path.join(getGeminiHome(), explicit);
    return [{ client: classifyClientDir(resolved), dataDir: resolved }];
  }
  const geminiHome = getGeminiHome();
  const candidates = [
    { client: "app", dataDir: path.join(geminiHome, "antigravity") },
    { client: "cli", dataDir: path.join(geminiHome, "antigravity-cli") },
    { client: "ide", dataDir: path.join(geminiHome, "antigravity-ide") }
  ];
  const existing = candidates.filter((c) => fs.existsSync(c.dataDir));
  if (existing.length > 0) return existing;
  return [candidates[1]];
}
function inferDataDirFromTranscriptPath(transcriptPath) {
  const raw = String(transcriptPath || "").trim();
  if (!raw) return "";
  const normalized = path.resolve(raw).replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/brain/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}
function normalizeCanonicalPath(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "";
  let candidate = trimmed;
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(candidate.replace(/^file:\/\//i, ""));
      if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
    } catch {
      candidate = candidate.replace(/^file:\/\//i, "");
    }
  }
  try {
    if (fs.existsSync(candidate)) {
      candidate = typeof fs.realpathSync.native === "function" ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate);
    }
  } catch {
  }
  let slash = candidate.replace(/\\/g, "/");
  if (/^[A-Z]:\//.test(slash)) {
    slash = `${slash[0].toLowerCase()}${slash.slice(1)}`;
  }
  while (slash.length > 1 && slash.endsWith("/") && !/^[a-zA-Z]:\/$/.test(slash)) {
    slash = slash.slice(0, -1);
  }
  return slash;
}
function isTempDirectory(rawPath) {
  const p = normalizeCanonicalPath(rawPath).toLowerCase();
  if (!p) return false;
  if (p === "/tmp" || p.startsWith("/tmp/") || p === "/private/tmp" || p.startsWith("/private/tmp/")) {
    return true;
  }
  if (p === "/var/tmp" || p.startsWith("/var/tmp/") || p.includes("/appdata/local/temp/")) {
    return true;
  }
  return false;
}
function resolveGitCommonDir(startDir) {
  const start = normalizeCanonicalPath(startDir);
  if (!start) return "";
  let cur = start;
  try {
    if (fs.existsSync(cur) && fs.statSync(cur).isFile()) {
      cur = path.dirname(cur);
    }
  } catch {
    return "";
  }
  for (let depth = 0; depth < 32; depth += 1) {
    const dotGit = path.join(cur, ".git");
    try {
      const st = fs.lstatSync(dotGit);
      if (st.isDirectory()) {
        if (fs.existsSync(path.join(dotGit, "HEAD"))) {
          return normalizeCanonicalPath(dotGit);
        }
      } else if (st.isFile()) {
        const content = fs.readFileSync(dotGit, "utf8");
        const m = /^gitdir:\s*(.+)$/im.exec(content);
        if (!m?.[1]) return "";
        const gitDir = path.resolve(cur, m[1].trim());
        const commonFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonFile)) {
          const relCommon = fs.readFileSync(commonFile, "utf8").trim();
          if (relCommon) {
            return normalizeCanonicalPath(path.resolve(gitDir, relCommon));
          }
        }
        return normalizeCanonicalPath(gitDir);
      }
    } catch {
    }
    const parent = path.dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return "";
}
function isValidConversationId(id) {
  return CONVERSATION_ID_RE.test(String(id || "").trim());
}
function isValidProjectId(id) {
  const trimmed = String(id || "").trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed.includes("..") || trimmed.includes("\\")) return false;
  return PROJECT_ID_RE.test(trimmed);
}
function decodeTrajectoryMetadata(blob) {
  if (!blob || blob.byteLength === 0 || blob.byteLength > MAX_TRAJECTORY_BLOB_BYTES) {
    return null;
  }
  let pos = 0;
  const len = blob.byteLength;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let foundProjectId = null;
  const workspaces = [];
  const readVarint = () => {
    let value = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      if (pos >= len) return null;
      const b = blob[pos];
      pos += 1;
      if (count === 9 && b > 1) return null;
      value |= BigInt(b & 127) << shift;
      if ((b & 128) === 0) return value;
      shift += 7n;
    }
    return null;
  };
  while (pos < len) {
    const tag = readVarint();
    if (tag === null || tag <= 0n) return null;
    const wireType = Number(tag & 7n);
    const fieldNumber = tag >> 3n;
    if (fieldNumber <= 0n) return null;
    if (wireType === 0) {
      if (readVarint() === null) return null;
    } else if (wireType === 1) {
      if (pos + 8 > len) return null;
      pos += 8;
    } else if (wireType === 2) {
      const byteLenBig = readVarint();
      if (byteLenBig === null || byteLenBig < 0n || byteLenBig > BigInt(len - pos)) return null;
      const byteLen = Number(byteLenBig);
      const slice = blob.subarray(pos, pos + byteLen);
      pos += byteLen;
      if (fieldNumber === 7n) {
        try {
          const uri = decoder.decode(slice).trim();
          const norm = normalizeCanonicalPath(uri);
          if (norm && !workspaces.includes(norm)) workspaces.push(norm);
        } catch {
          return null;
        }
      } else if (fieldNumber === 18n) {
        let decoded;
        try {
          decoded = decoder.decode(slice).trim();
        } catch {
          return null;
        }
        if (!isValidProjectId(decoded)) return null;
        if (foundProjectId !== null && foundProjectId !== decoded) return null;
        foundProjectId = decoded;
      }
    } else if (wireType === 5) {
      if (pos + 4 > len) return null;
      pos += 4;
    } else {
      return null;
    }
  }
  return { projectId: foundProjectId, workspaces };
}
function readConversationDbMeta(dataDir, conversationId, timeoutMs = getBusyTimeoutMs()) {
  const cid = String(conversationId || "").trim();
  if (!isValidConversationId(cid)) {
    return { projectId: null, workspaces: [], error: "invalid conversationId" };
  }
  const dbPath = path.join(path.resolve(dataDir), "conversations", `${cid}.db`);
  if (!fs.existsSync(dbPath)) {
    return { projectId: null, workspaces: [] };
  }
  const DatabaseSync = getNodeSqliteCtor();
  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
      if (typeof db.exec === "function") {
        db.exec(`PRAGMA busy_timeout = ${timeoutMs};`);
      }
      const rows = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").all();
      const raw = rows[0]?.data;
      if (raw instanceof Uint8Array) {
        const meta = decodeTrajectoryMetadata(raw);
        return meta ? meta : { projectId: null, workspaces: [], error: "invalid trajectory blob" };
      }
      return { projectId: null, workspaces: [] };
    } catch (err) {
      return { projectId: null, workspaces: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }
  for (const sqliteBin of SQLITE_CANDIDATES) {
    try {
      const stdout = execFileSync(
        sqliteBin,
        [
          "-cmd",
          `.timeout ${timeoutMs}`,
          "-readonly",
          "-json",
          dbPath,
          "SELECT hex(data) AS hexdata FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1;"
        ],
        {
          encoding: "utf8",
          timeout: Math.max(2e3, timeoutMs + 1500),
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      const trimmed = String(stdout || "").trim();
      if (!trimmed) return { projectId: null, workspaces: [] };
      const rows = JSON.parse(trimmed);
      const hex = typeof rows[0]?.hexdata === "string" ? rows[0].hexdata : "";
      if (!hex) return { projectId: null, workspaces: [] };
      const meta = decodeTrajectoryMetadata(Buffer.from(hex, "hex"));
      return meta ? meta : { projectId: null, workspaces: [], error: "invalid trajectory blob" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(msg)) continue;
      return { projectId: null, workspaces: [], error: msg };
    }
  }
  const pyScript = `
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=float(sys.argv[2]) / 1000.0)
try:
  row = con.execute("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").fetchone()
  print(json.dumps({"hex": row[0].hex() if row and isinstance(row[0], (bytes, bytearray)) else ""}))
finally:
  con.close()
`;
  for (const inv of PYTHON_INVOCATIONS) {
    try {
      const stdout = execFileSync(inv.bin, [...inv.prefixArgs, "-c", pyScript, dbPath, String(timeoutMs)], {
        encoding: "utf8",
        timeout: Math.max(2500, timeoutMs + 1500),
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const parsed = JSON.parse(stdout);
      if (!parsed.hex) return { projectId: null, workspaces: [] };
      const meta = decodeTrajectoryMetadata(Buffer.from(parsed.hex, "hex"));
      return meta ? meta : { projectId: null, workspaces: [], error: "invalid trajectory blob" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(msg)) continue;
      return { projectId: null, workspaces: [], error: msg };
    }
  }
  return { projectId: null, workspaces: [], error: "no sqlite reader available" };
}
function pickPrimaryWorkspaceRoot(workspaces) {
  const candidates = [];
  for (const w of workspaces) {
    const norm = normalizeCanonicalPath(w);
    if (norm && !candidates.includes(norm)) candidates.push(norm);
  }
  if (candidates.length === 0) return "";
  const nonTemp = candidates.find((c) => !isTempDirectory(c));
  return nonTemp || candidates[0];
}
function resolveScopeKey(input) {
  const rawPid = String(input.projectId ?? "").trim();
  if (!rawPid) {
    return { kind: "unresolved", reason: "missing project_id" };
  }
  if (!isValidProjectId(rawPid)) {
    return { kind: "unresolved", reason: "invalid project_id" };
  }
  if (!DEFAULT_PROJECT_SENTINELS.has(rawPid)) {
    return { kind: "project", projectId: rawPid };
  }
  const root = pickPrimaryWorkspaceRoot(input.workspaces || []);
  if (!root) {
    return { kind: "unresolved", reason: "default-cli-project without workspace" };
  }
  const commonGitDir = resolveGitCommonDir(root);
  if (commonGitDir) {
    return { kind: "cli_repo", commonGitDir };
  }
  return { kind: "cli_workspace", root };
}
function formatScopeKey(scope) {
  switch (scope.kind) {
    case "project":
      return `project/${scope.projectId}`;
    case "cli_repo":
      return `cli_repo/${scope.commonGitDir}`;
    case "cli_workspace":
      return `cli_workspace/${scope.root}`;
    case "global":
      return "global";
    case "unresolved":
      return "unresolved";
  }
}
function scopeKeysEqual(a, b) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "project":
      return a.projectId === b.projectId;
    case "cli_repo":
      return a.commonGitDir === b.commonGitDir;
    case "cli_workspace":
      return a.root === b.root;
    case "global":
      return true;
    case "unresolved":
      return false;
  }
}
function scopeKeyToBoardDir(scope, boardsHome = resolveBoardsHome()) {
  if (scope.kind === "unresolved") {
    throw new Error("Cannot map unresolved scope to a board directory.");
  }
  if (scope.kind === "global") {
    return path.join(path.resolve(boardsHome), "boards", "global");
  }
  const canonical = formatScopeKey(scope);
  const hash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 20);
  const label = scope.kind === "project" ? scope.projectId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) : path.posix.basename(scope.kind === "cli_repo" ? path.posix.dirname(scope.commonGitDir) : scope.root).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "ws";
  return path.join(path.resolve(boardsHome), "boards", `${scope.kind}_${label}_${hash}`);
}

// src/board.ts
var KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));
function isValidBoardKey(rawKey) {
  return KEY_RE.test(String(rawKey || "").trim());
}
function normalizeBoardKey(rawKey) {
  return String(rawKey || "").trim().toLowerCase();
}
function parseYamlScalar(raw) {
  const s = raw.trim();
  if (!s) return "";
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}
function computeBoardRevision(entry) {
  const canonical = JSON.stringify({
    key: entry.key,
    title: entry.title,
    body: entry.body,
    updatedAt: entry.updatedAt,
    source: entry.source || null
  });
  return crypto2.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}
function parseBoardEntryFile(filePath, scope) {
  let raw;
  let st;
  try {
    raw = fs2.readFileSync(filePath, "utf8");
    st = fs2.statSync(filePath);
  } catch {
    return null;
  }
  const slug = path2.basename(filePath, ".md");
  const normalized = raw.replace(/\r\n/g, "\n");
  let key = slug;
  let title = "";
  let updatedAt = Math.floor(st.mtimeMs || Date.now());
  let sourceClient = "cli";
  let sourceSession = "";
  let sourceStep;
  let body = normalized.trim();
  if (normalized.startsWith("---\n")) {
    const endIdx = normalized.indexOf("\n---\n", 4);
    if (endIdx > 0) {
      const fm = normalized.slice(4, endIdx);
      body = normalized.slice(endIdx + 5).trim();
      for (const line of fm.split("\n")) {
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k === "key") {
          const parsedKey = normalizeBoardKey(parseYamlScalar(v));
          if (isValidBoardKey(parsedKey)) key = parsedKey;
        } else if (k === "title") {
          title = parseYamlScalar(v);
        } else if (k === "updatedAt") {
          const parsed = Date.parse(parseYamlScalar(v));
          if (!Number.isNaN(parsed)) updatedAt = parsed;
        } else if (k === "sourceClient") {
          const c = parseYamlScalar(v);
          if (c === "app" || c === "cli" || c === "ide" || c === "custom") sourceClient = c;
        } else if (k === "sourceSession") {
          sourceSession = parseYamlScalar(v);
        } else if (k === "sourceStep") {
          const num = Number(v);
          if (Number.isInteger(num) && num >= 0) sourceStep = num;
        }
      }
    }
  }
  const source = sourceSession ? { client: sourceClient, conversationId: sourceSession, ...sourceStep !== void 0 ? { step: sourceStep } : {} } : void 0;
  const revision = computeBoardRevision({ key, title, body, updatedAt, source });
  return {
    key,
    title,
    body,
    revision,
    updatedAt,
    scope,
    source,
    filePath
  };
}
function getBoardEntriesDir(scope, boardsHome = resolveBoardsHome()) {
  return path2.join(scopeKeyToBoardDir(scope, boardsHome), "entries");
}
function loadBoardEntries(scope, boardsHome = resolveBoardsHome()) {
  if (scope.kind === "unresolved") return [];
  const entriesDir = getBoardEntriesDir(scope, boardsHome);
  let files;
  try {
    files = fs2.readdirSync(entriesDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const fn of files) {
    const parsed = parseBoardEntryFile(path2.join(entriesDir, fn), scope);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  return out;
}

// src/store.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";
import path3 from "node:path";
var catalogCache = /* @__PURE__ */ new Map();
function statSignature(filePath) {
  try {
    const st = fs3.statSync(filePath);
    return `${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return "missing";
  }
}
function resolveDataDir(overrideDir = "") {
  const roots = discoverClientDataDirs(overrideDir);
  return roots[0].dataDir;
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
function decodeWorkspaceUris(raw) {
  let arr = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [raw];
    }
  }
  return arr.map((u) => {
    if (typeof u !== "string") return "";
    let p = u.trim();
    if (p.startsWith("file://")) {
      try {
        p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
      } catch {
        p = p.replace(/^file:\/\//i, "");
      }
    }
    return p;
  }).filter(Boolean);
}
function parseSessionIdList(spec) {
  if (!spec) return [];
  const rawItems = Array.isArray(spec) ? spec : String(spec).split(",");
  return rawItems.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean);
}
function splitClientRef(ref) {
  const trimmed = String(ref || "").trim();
  const m = /^(app|cli|ide|custom|agy):(.+)$/i.exec(trimmed);
  if (m && m[1] && m[2]) {
    const prefix = m[1].toLowerCase();
    const id = m[2].trim();
    if (prefix === "agy") return { client: null, id };
    return { client: prefix, id };
  }
  return { client: null, id: trimmed };
}
function matchesSessionId(sessionId, spec, sessionClient = "cli") {
  const items = parseSessionIdList(spec);
  if (items.length === 0) return false;
  const lowId = String(sessionId || "").toLowerCase();
  return items.some((rawItem) => {
    const { client, id } = splitClientRef(rawItem);
    if (client && client !== sessionClient) return false;
    const low = id.toLowerCase();
    if (!low) return false;
    return lowId === low || low.length >= 4 && lowId.startsWith(low);
  });
}
function getSessionPaths(dataDir, conversationId) {
  const brainDir = path3.join(dataDir, "brain", conversationId);
  const systemDir = path3.join(brainDir, ".system_generated");
  return {
    brainDir,
    systemDir,
    transcriptPath: path3.join(systemDir, "logs", "transcript.jsonl"),
    transcriptFullPath: path3.join(systemDir, "logs", "transcript_full.jsonl"),
    swarmDir: path3.join(systemDir, "swarm"),
    swarmMembersPath: path3.join(systemDir, "swarm", "members.json"),
    swarmBoardPath: path3.join(systemDir, "swarm", "board.jsonl"),
    swarmPlanPath: path3.join(systemDir, "swarm", "plan.json"),
    subagentsDir: path3.join(systemDir, "subagents")
  };
}
function buildDynamicSelectSql(columns) {
  const col = (name, fallbackExpr) => columns.has(name) ? name : `${fallbackExpr} AS ${name}`;
  return [
    "SELECT",
    [
      col("conversation_id", "''"),
      col("title", "''"),
      col("preview", "''"),
      col("step_count", "0"),
      col("last_modified_time", "''"),
      col("workspace_uris", "'[]'"),
      col("status", "''"),
      col("project_id", "''"),
      col("app_data_dir", "''"),
      col("not_fully_idle", "0"),
      col("parent_conversation_id", "''"),
      col("nesting_depth", "0"),
      col("last_user_input_time", "''")
    ].join(", "),
    "FROM conversation_summaries",
    "ORDER BY last_modified_time DESC"
  ].join(" ");
}
function mapDbRow(r) {
  return {
    conversationId: String(r.conversation_id ?? ""),
    title: String(r.title ?? ""),
    preview: String(r.preview ?? ""),
    stepCount: Number(r.step_count ?? 0),
    lastModifiedTime: String(r.last_modified_time ?? ""),
    workspaceUris: typeof r.workspace_uris === "string" ? r.workspace_uris : "[]",
    status: String(r.status ?? ""),
    projectId: String(r.project_id ?? ""),
    appDataDir: String(r.app_data_dir ?? ""),
    notFullyIdle: Boolean(Number(r.not_fully_idle ?? 0) || r.not_fully_idle === true),
    parentConversationId: String(r.parent_conversation_id ?? ""),
    nestingDepth: Number(r.nesting_depth ?? 0),
    lastUserInputTime: String(r.last_user_input_time ?? "")
  };
}
function querySummariesViaNodeSqlite(dbPath, timeoutMs) {
  const DatabaseSync = getNodeSqliteCtor();
  if (!DatabaseSync) return null;
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
    if (typeof db.exec === "function") {
      db.exec(`PRAGMA busy_timeout = ${timeoutMs};`);
    }
    const colsRaw = db.prepare("PRAGMA table_info(conversation_summaries)").all();
    const cols = new Set(colsRaw.map((c) => String(c.name ?? "")));
    if (cols.size === 0) return null;
    const rows = db.prepare(buildDynamicSelectSql(cols)).all();
    return Array.isArray(rows) ? rows.map(mapDbRow) : null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function querySummariesViaSqliteCli(dbPath, timeoutMs) {
  for (const sqliteBin of SQLITE_CANDIDATES) {
    try {
      const colOut = execFileSync2(
        sqliteBin,
        ["-cmd", `.timeout ${timeoutMs}`, "-readonly", "-json", dbPath, "PRAGMA table_info(conversation_summaries);"],
        {
          encoding: "utf8",
          timeout: Math.max(2500, timeoutMs + 1500),
          maxBuffer: 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"]
        }
      );
      const colRows = JSON.parse(String(colOut || "[]").trim() || "[]");
      const cols = new Set(colRows.map((c) => String(c.name ?? "")));
      if (cols.size === 0) continue;
      const sql = `${buildDynamicSelectSql(cols)};`;
      const stdout = execFileSync2(sqliteBin, ["-cmd", `.timeout ${timeoutMs}`, "-readonly", "-json", dbPath, sql], {
        encoding: "utf8",
        timeout: Math.max(3e3, timeoutMs + 2e3),
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
function querySummariesViaPython(dbPath, timeoutMs) {
  const pyScript = `
import json, pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=float(sys.argv[2]) / 1000.0)
try:
  cols = {r[1] for r in con.execute("PRAGMA table_info(conversation_summaries)").fetchall()}
  def c(name, fb): return name if name in cols else f"{fb} AS {name}"
  sql = "SELECT " + ", ".join([
    c("conversation_id", "''"), c("title", "''"), c("preview", "''"), c("step_count", "0"),
    c("last_modified_time", "''"), c("workspace_uris", "'[]'"), c("status", "''"),
    c("project_id", "''"), c("app_data_dir", "''"), c("not_fully_idle", "0"),
    c("parent_conversation_id", "''"), c("nesting_depth", "0"), c("last_user_input_time", "''")
  ]) + " FROM conversation_summaries ORDER BY last_modified_time DESC"
  rows = con.execute(sql).fetchall()
  out = []
  for r in rows:
    out.append({
      "conversationId": r[0] or "", "title": r[1] or "", "preview": r[2] or "",
      "stepCount": int(r[3] or 0), "lastModifiedTime": r[4] or "", "workspaceUris": r[5] or "[]",
      "status": r[6] or "", "projectId": r[7] or "", "appDataDir": r[8] or "",
      "notFullyIdle": bool(r[9]), "parentConversationId": r[10] or "",
      "nestingDepth": int(r[11] or 0), "lastUserInputTime": r[12] or ""
    })
  print(json.dumps(out))
finally:
  con.close()
`;
  for (const inv of PYTHON_INVOCATIONS) {
    try {
      const stdout = execFileSync2(inv.bin, [...inv.prefixArgs, "-c", pyScript, dbPath, String(timeoutMs)], {
        encoding: "utf8",
        timeout: Math.max(3e3, timeoutMs + 2e3),
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
  const brainRoot = path3.join(dataDir, "brain");
  let dirs = [];
  try {
    dirs = fs3.readdirSync(brainRoot);
  } catch {
    return [];
  }
  const childIds = /* @__PURE__ */ new Set();
  for (const id of dirs) {
    const p = getSessionPaths(dataDir, id);
    try {
      const subFiles = fs3.readdirSync(p.subagentsDir).filter((f) => f.endsWith(".json"));
      for (const f of subFiles) childIds.add(f.replace(/\.json$/, ""));
    } catch {
    }
    try {
      const members = JSON.parse(fs3.readFileSync(p.swarmMembersPath, "utf8"));
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
      st = fs3.statSync(p.transcriptPath);
    } catch {
      try {
        st = fs3.statSync(p.brainDir);
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
      projectId: "",
      appDataDir: path3.basename(dataDir),
      notFullyIdle: false,
      parentConversationId: childIds.has(id) ? "inferred" : "",
      nestingDepth: childIds.has(id) ? 1 : 0,
      lastUserInputTime: ""
    });
  }
  out.sort((a, b) => parseAgyTimestamp(b.lastModifiedTime) - parseAgyTimestamp(a.lastModifiedTime));
  return out;
}
function computeCatalogSignature(dataDir) {
  const dbPath = path3.join(dataDir, "conversation_summaries.db");
  const walPath = `${dbPath}-wal`;
  const brainRoot = path3.join(dataDir, "brain");
  return `${statSignature(dbPath)}|${statSignature(walPath)}|${statSignature(brainRoot)}`;
}
function loadSingleRootCatalog(root) {
  const resolvedDir = path3.resolve(root.dataDir);
  const sig = computeCatalogSignature(resolvedDir);
  const cached = catalogCache.get(resolvedDir);
  if (cached && cached.sig === sig) {
    for (const entry of cached.entries) {
      if (!entry.hasTranscript && fs3.existsSync(entry.paths.transcriptPath)) {
        entry.hasTranscript = true;
      }
      if (!entry.hasSwarm && (fs3.existsSync(entry.paths.swarmMembersPath) || fs3.existsSync(entry.paths.swarmBoardPath))) {
        entry.hasSwarm = true;
      }
    }
    return cached.entries;
  }
  const dbPath = path3.join(resolvedDir, "conversation_summaries.db");
  const timeoutMs = getBusyTimeoutMs();
  let rawRows = null;
  let dbReadDegraded = false;
  if (fs3.existsSync(dbPath)) {
    rawRows = querySummariesViaNodeSqlite(dbPath, timeoutMs);
    if (!Array.isArray(rawRows)) {
      rawRows = querySummariesViaSqliteCli(dbPath, timeoutMs);
    }
    if (!Array.isArray(rawRows)) {
      rawRows = querySummariesViaPython(dbPath, timeoutMs);
    }
    if (!Array.isArray(rawRows)) {
      dbReadDegraded = true;
    }
  }
  if (!Array.isArray(rawRows)) {
    rawRows = scanBrainDirsFallback(resolvedDir);
  }
  const seen = new Set(rawRows.map((r) => r.conversationId));
  const brainRoot = path3.join(resolvedDir, "brain");
  const inferredChildIds = /* @__PURE__ */ new Set();
  try {
    const allBrainIds = fs3.readdirSync(brainRoot);
    for (const id of allBrainIds) {
      if (id.startsWith(".")) continue;
      const p = getSessionPaths(resolvedDir, id);
      try {
        for (const f of fs3.readdirSync(p.subagentsDir)) {
          if (f.endsWith(".json")) inferredChildIds.add(f.replace(/\.json$/, ""));
        }
      } catch {
      }
    }
    for (const id of allBrainIds) {
      if (id.startsWith(".") || seen.has(id)) continue;
      const p = getSessionPaths(resolvedDir, id);
      if (!fs3.existsSync(p.transcriptPath)) continue;
      const st = fs3.statSync(p.transcriptPath);
      rawRows.push({
        conversationId: id,
        title: "",
        preview: "",
        stepCount: 0,
        lastModifiedTime: new Date(st.mtimeMs).toISOString(),
        workspaceUris: "[]",
        status: "",
        projectId: "",
        appDataDir: path3.basename(resolvedDir),
        notFullyIdle: false,
        parentConversationId: inferredChildIds.has(id) ? "inferred" : "",
        nestingDepth: inferredChildIds.has(id) ? 1 : 0,
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
    const hasTranscript = fs3.existsSync(paths.transcriptPath);
    const hasSwarm = fs3.existsSync(paths.swarmMembersPath) || fs3.existsSync(paths.swarmBoardPath);
    const isChild = Boolean(row.parentConversationId) || (row.nestingDepth || 0) > 0;
    const client = row.appDataDir ? classifyClientDir(row.appDataDir) : root.client;
    const scopeKey = resolveScopeKey({ projectId: row.projectId, workspaces });
    return {
      client,
      dataDir: resolvedDir,
      canonicalId: `${client}:${row.conversationId}`,
      sessionId: row.conversationId,
      shortId: row.conversationId.slice(0, 8),
      title: String(row.title || "").trim(),
      preview: String(row.preview || "").trim(),
      stepCount: Number(row.stepCount) || 0,
      updatedMs,
      workspaces,
      status: String(row.status || ""),
      projectId: String(row.projectId || "").trim(),
      notFullyIdle: Boolean(row.notFullyIdle),
      scopeKey,
      isChild,
      parentConversationId: String(row.parentConversationId || ""),
      hasTranscript,
      hasSwarm,
      paths
    };
  }).sort((a, b) => b.updatedMs - a.updatedMs);
  if (!dbReadDegraded) {
    catalogCache.set(resolvedDir, { sig, entries });
  }
  return entries;
}
function loadMultiClientCatalog(overrideDir = "") {
  const roots = discoverClientDataDirs(overrideDir);
  const grouped = /* @__PURE__ */ new Map();
  const clientCounts = {};
  for (const root of roots) {
    const list = loadSingleRootCatalog(root);
    clientCounts[root.client] = (clientCounts[root.client] || 0) + list.length;
    for (const entry of list) {
      const bucket = grouped.get(entry.sessionId);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.sessionId, [entry]);
    }
  }
  const merged = [];
  for (const copies of grouped.values()) {
    if (copies.length === 1) {
      merged.push(copies[0]);
      continue;
    }
    copies.sort((a, b) => {
      if (b.updatedMs !== a.updatedMs) return b.updatedMs - a.updatedMs;
      const aScore = (a.hasTranscript ? 2 : 0) + (a.projectId ? 1 : 0);
      const bScore = (b.hasTranscript ? 2 : 0) + (b.projectId ? 1 : 0);
      return bScore - aScore;
    });
    const newest = copies[0];
    const transcriptBearing = copies.find((c) => c.hasTranscript) || newest;
    const distinctProjectIds = new Set(copies.map((c) => c.projectId).filter(Boolean));
    const distinctScopes = new Set(
      copies.filter((c) => c.scopeKey.kind !== "unresolved").map((c) => formatScopeKey(c.scopeKey))
    );
    const hasConflict = distinctProjectIds.size > 1 || distinctScopes.size > 1;
    const chosenProjectId = hasConflict ? "" : [...distinctProjectIds][0] || newest.projectId;
    const chosenWorkspaces = newest.workspaces.length ? newest.workspaces : transcriptBearing.workspaces;
    const chosenScope = hasConflict ? { kind: "unresolved", reason: "conflicting project_id across clients" } : resolveScopeKey({ projectId: chosenProjectId, workspaces: chosenWorkspaces });
    merged.push({
      ...newest,
      dataDir: transcriptBearing.dataDir,
      paths: transcriptBearing.paths,
      hasTranscript: newest.hasTranscript || transcriptBearing.hasTranscript,
      hasSwarm: newest.hasSwarm || transcriptBearing.hasSwarm,
      projectId: chosenProjectId,
      workspaces: chosenWorkspaces,
      scopeKey: chosenScope
    });
  }
  const entries = merged.sort((a, b) => b.updatedMs - a.updatedMs);
  const coverageLabel = Object.entries(clientCounts).map(([k, v]) => `${k}:${v}`).join(", ");
  return { entries, clientCounts, coverageLabel };
}
function resolveConversationContext(opts) {
  const cid = String(opts.conversationId || "").trim();
  const hintWorkspaces = (opts.hintWorkspaces || []).filter(Boolean);
  if (!isValidConversationId(cid)) {
    return {
      conversationId: cid,
      client: "cli",
      dataDir: opts.hintDataDir || resolveDataDir(opts.overrideDataDir),
      projectId: "",
      workspaces: hintWorkspaces,
      scopeKey: { kind: "unresolved", reason: "invalid conversationId" },
      diagnostic: "Invalid conversationId format."
    };
  }
  const catalog = opts.catalog || loadMultiClientCatalog(opts.overrideDataDir).entries;
  const summaryEntry = catalog.find((e) => e.sessionId === cid) || null;
  if (summaryEntry && summaryEntry.scopeKey.kind === "unresolved" && summaryEntry.scopeKey.reason?.includes("conflicting")) {
    return {
      conversationId: cid,
      client: summaryEntry.client,
      dataDir: summaryEntry.dataDir,
      projectId: "",
      workspaces: summaryEntry.workspaces,
      scopeKey: summaryEntry.scopeKey,
      diagnostic: summaryEntry.scopeKey.reason
    };
  }
  const roots = discoverClientDataDirs(opts.overrideDataDir);
  const candidateDirs = [];
  if (opts.hintDataDir) candidateDirs.push(path3.resolve(opts.hintDataDir));
  if (summaryEntry?.dataDir && !candidateDirs.includes(summaryEntry.dataDir)) {
    candidateDirs.push(summaryEntry.dataDir);
  }
  for (const r of roots) {
    if (!candidateDirs.includes(r.dataDir)) candidateDirs.push(r.dataDir);
  }
  const observedProjectIds = /* @__PURE__ */ new Set();
  if (summaryEntry?.projectId) observedProjectIds.add(summaryEntry.projectId);
  let protoWorkspaces = [];
  let protoDataDir = "";
  for (const dir of candidateDirs) {
    const res = readConversationDbMeta(dir, cid);
    if (res.projectId) {
      observedProjectIds.add(res.projectId);
      if (!protoDataDir) protoDataDir = dir;
    }
    if (protoWorkspaces.length === 0 && res.workspaces.length > 0) {
      protoWorkspaces = res.workspaces;
    }
  }
  if (observedProjectIds.size > 1) {
    return {
      conversationId: cid,
      client: summaryEntry?.client || classifyClientDir(protoDataDir || candidateDirs[0] || ""),
      dataDir: summaryEntry?.dataDir || protoDataDir || candidateDirs[0] || "",
      projectId: "",
      workspaces: summaryEntry?.workspaces.length ? summaryEntry.workspaces : protoWorkspaces.length ? protoWorkspaces : hintWorkspaces,
      scopeKey: { kind: "unresolved", reason: "conflicting project_id" },
      diagnostic: `Conflicting project_id values observed for ${cid}: ${[...observedProjectIds].join(", ")}.`
    };
  }
  const effectiveProjectId = [...observedProjectIds][0] || "";
  const effectiveDataDir = summaryEntry?.dataDir || protoDataDir || candidateDirs[0] || resolveDataDir(opts.overrideDataDir);
  const effectiveClient = summaryEntry?.client || classifyClientDir(effectiveDataDir);
  const effectiveWorkspaces = summaryEntry?.workspaces.length ? summaryEntry.workspaces : protoWorkspaces.length ? protoWorkspaces : hintWorkspaces;
  const scopeKey = resolveScopeKey({
    projectId: effectiveProjectId,
    workspaces: effectiveWorkspaces
  });
  return {
    conversationId: cid,
    client: effectiveClient,
    dataDir: effectiveDataDir,
    projectId: effectiveProjectId,
    workspaces: effectiveWorkspaces,
    scopeKey
  };
}

// src/snapshot.ts
var INLINE_BOARD_BYTE_CAP = 1536;
var INDEX_BOARD_BYTE_CAP = 1536;
var RECENT_SIBLING_WINDOW_MS = 7 * 24 * 3600 * 1e3;
function collectWorkspacePaths(payload) {
  const out = [];
  const add = (val) => {
    if (typeof val === "string" && val.trim() && !out.includes(val.trim())) {
      out.push(val.trim());
    }
  };
  for (const list of [
    payload.workspacePaths,
    payload.workspace_paths,
    payload.workspaceRoots,
    payload.workspace_roots
  ]) {
    if (Array.isArray(list)) {
      for (const item of list) add(item);
    }
  }
  if (out.length === 0) add(payload.cwd);
  return out;
}
function renderInlineBoardSection(entries, now) {
  const blocks = [`Project board (${entries.length} active, inline):`];
  for (const e of entries) {
    const scopeTag = e.scope.kind === "global" ? " [global]" : "";
    const titleTag = e.title && e.title !== e.key ? ` \u2014 ${e.title}` : "";
    const srcTag = e.source?.conversationId ? ` \xB7 from ${e.source.conversationId.slice(0, 8)}${e.source.step !== void 0 ? `#${e.source.step}` : ""}` : "";
    blocks.push(
      `## ${e.key}${scopeTag}${titleTag} (rev=${e.revision} \xB7 ${formatRelativeTime(e.updatedAt, now)}${srcTag})
${e.body}`
    );
  }
  return blocks.join("\n");
}
function renderKeyIndexSection(entries, fullBytes, now) {
  const header = `Project board (${entries.length} active, ${fullBytes} B > ${INLINE_BOARD_BYTE_CAP} B cap; call board_read for full entries):`;
  const lines = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  let shown = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const scopeTag = e.scope.kind === "global" ? " [global]" : "";
    const titleTag = e.title && e.title !== e.key ? ` \u2014 ${e.title}` : "";
    const srcTag = e.source?.conversationId ? ` \xB7 from ${e.source.conversationId.slice(0, 8)}${e.source.step !== void 0 ? `#${e.source.step}` : ""}` : "";
    const line = `- ${e.key}${scopeTag}${titleTag} (${formatRelativeTime(e.updatedAt, now)} \xB7 rev=${e.revision}${srcTag})`;
    const remainingAfter = entries.length - (i + 1);
    const footerReserve = remainingAfter > 0 ? Buffer.byteLength(`
(+${remainingAfter} more keys; call board_read)`, "utf8") : 0;
    const lineBytes = Buffer.byteLength(`
${line}`, "utf8");
    if (usedBytes + lineBytes + footerReserve > INDEX_BOARD_BYTE_CAP) {
      break;
    }
    lines.push(line);
    usedBytes += lineBytes;
    shown += 1;
  }
  const omitted = entries.length - shown;
  if (omitted > 0) {
    lines.push(`(+${omitted} more keys; call board_read)`);
  }
  return lines.join("\n");
}
function renderBoardSnapshotSection(scope, boardsHome = resolveBoardsHome(), now = Date.now()) {
  if (scope.kind === "unresolved") {
    return { text: "", mode: "empty", entryCount: 0, renderedBytes: 0 };
  }
  const projectEntries = loadBoardEntries(scope, boardsHome);
  const globalEntries = scope.kind === "global" ? [] : loadBoardEntries({ kind: "global" }, boardsHome);
  const entries = [...projectEntries, ...globalEntries];
  if (entries.length === 0) {
    const text = "Project board: empty.";
    return { text, mode: "empty", entryCount: 0, renderedBytes: Buffer.byteLength(text, "utf8") };
  }
  const fullInline = renderInlineBoardSection(entries, now);
  const fullBytes = Buffer.byteLength(fullInline, "utf8");
  if (fullBytes <= INLINE_BOARD_BYTE_CAP) {
    return { text: fullInline, mode: "inline", entryCount: entries.length, renderedBytes: fullBytes };
  }
  const indexText = renderKeyIndexSection(entries, fullBytes, now);
  return {
    text: indexText,
    mode: "index",
    entryCount: entries.length,
    renderedBytes: Buffer.byteLength(indexText, "utf8")
  };
}
function buildSessionStartSnapshot(payload = {}, opts = {}) {
  const currentId = String(
    payload.conversationId || payload.conversation_id || payload.sessionId || payload.session_id || ""
  ).trim();
  const transcriptPath = String(payload.transcriptPath || payload.transcript_path || "").trim();
  const hintDataDir = inferDataDirFromTranscriptPath(transcriptPath);
  const workspaces = collectWorkspacePaths(payload);
  const now = opts.now ?? Date.now();
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const includeSiblingHint = opts.includeSiblingHint !== void 0 ? opts.includeSiblingHint : process.env.AGY_MEMORY_SIBLING_HINT !== "0";
  const { entries: catalog } = loadMultiClientCatalog(opts.overrideDataDir || "");
  const ctx = resolveConversationContext({
    conversationId: currentId,
    overrideDataDir: opts.overrideDataDir || "",
    hintDataDir,
    hintWorkspaces: workspaces,
    catalog
  });
  if (!currentId && ctx.scopeKey.kind === "unresolved") {
    return "";
  }
  const scopeLabel = formatScopeKey(ctx.scopeKey);
  const header = currentId ? `[agy-memory] session=${currentId.slice(0, 8)} (id=${currentId}, scope=${scopeLabel})` : `[agy-memory] scope=${scopeLabel}`;
  if (ctx.scopeKey.kind === "unresolved") {
    return header;
  }
  const lines = [header];
  const boardSection = renderBoardSnapshotSection(ctx.scopeKey, boardsHome, now);
  if (boardSection.text) {
    lines.push(boardSection.text);
  }
  if (includeSiblingHint) {
    const recentCutoff = now - RECENT_SIBLING_WINDOW_MS;
    const siblingIds = /* @__PURE__ */ new Set();
    for (const s of catalog) {
      if (s.isChild) continue;
      if (currentId && matchesSessionId(s.sessionId, currentId, s.client)) continue;
      if (!scopeKeysEqual(s.scopeKey, ctx.scopeKey)) continue;
      if (!s.hasTranscript && !s.title && s.stepCount === 0) continue;
      if (s.notFullyIdle || s.updatedMs >= recentCutoff) {
        siblingIds.add(s.sessionId);
      }
    }
    if (siblingIds.size > 0) {
      lines.push(
        `Activity: ${siblingIds.size} other active or recent session(s) in this scope (call search_sessions with conversationId="${currentId}" if prior context is needed).`
      );
    }
  }
  return lines.join("\n");
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
