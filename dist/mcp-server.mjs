#!/usr/bin/env node
// agy-memory MCP Stdio Server & CLI (bundled zero-dependency ESM)


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
function parseExplicitScopeKey(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text === "global") return { kind: "global" };
  if (text.startsWith("project/")) {
    const pid = text.slice("project/".length).trim();
    if (isValidProjectId(pid) && !DEFAULT_PROJECT_SENTINELS.has(pid)) {
      return { kind: "project", projectId: pid };
    }
    return null;
  }
  if (text.startsWith("cli_repo/")) {
    const dir = normalizeCanonicalPath(text.slice("cli_repo/".length));
    return dir ? { kind: "cli_repo", commonGitDir: dir } : null;
  }
  if (text.startsWith("cli_workspace/")) {
    const dir = normalizeCanonicalPath(text.slice("cli_workspace/".length));
    return dir ? { kind: "cli_workspace", root: dir } : null;
  }
  return null;
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
var CORRUPT_LOCK_GRACE_MS = 2e3;
var REAP_GUARD_STALE_MS = 5e3;
var LOCK_WAIT_TIMEOUT_MS = 2e3;
var SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));
function isValidBoardKey(rawKey) {
  return KEY_RE.test(String(rawKey || "").trim());
}
function normalizeBoardKey(rawKey) {
  return String(rawKey || "").trim().toLowerCase();
}
function sleepSyncMs(ms) {
  try {
    Atomics.wait(SLEEP_ARR, 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err?.code;
    return code === "EPERM";
  }
}
function isLockStale(lockPath) {
  let st;
  try {
    st = fs2.statSync(lockPath);
  } catch {
    return false;
  }
  try {
    const raw = fs2.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return !isProcessAlive(parsed.pid);
    }
  } catch {
  }
  return Date.now() - st.mtimeMs > CORRUPT_LOCK_GRACE_MS;
}
function tryReapDeadLock(entriesDir, key, lockPath) {
  const reapDir = path2.join(entriesDir, `.${key}.reap`);
  try {
    fs2.mkdirSync(reapDir, { mode: 448 });
  } catch (err) {
    const code = err?.code;
    if (code === "EEXIST") {
      try {
        const st = fs2.statSync(reapDir);
        if (Date.now() - st.mtimeMs > REAP_GUARD_STALE_MS) {
          fs2.rmdirSync(reapDir);
        }
      } catch {
      }
    }
    return false;
  }
  try {
    if (isLockStale(lockPath)) {
      try {
        fs2.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    try {
      fs2.rmdirSync(reapDir);
    } catch {
    }
  }
}
function withPerKeyLock(entriesDir, key, fn) {
  fs2.mkdirSync(entriesDir, { recursive: true, mode: 448 });
  const lockPath = path2.join(entriesDir, `.${key}.lock`);
  const nonce = `${process.pid}-${Date.now()}-${crypto2.randomBytes(6).toString("hex")}`;
  const claimPath = path2.join(entriesDir, `.${key}.claim.${nonce}`);
  const lockPayload = JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() });
  const claimFd = fs2.openSync(claimPath, "wx", 384);
  try {
    fs2.writeFileSync(claimFd, lockPayload, "utf8");
    fs2.fsyncSync(claimFd);
  } finally {
    fs2.closeSync(claimFd);
  }
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let acquired = false;
  try {
    while (Date.now() < deadline) {
      try {
        fs2.linkSync(claimPath, lockPath);
        acquired = true;
        break;
      } catch (err) {
        const code = err?.code;
        if (code !== "EEXIST") {
          if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") {
            try {
              const fd = fs2.openSync(lockPath, "wx", 384);
              try {
                fs2.writeFileSync(fd, lockPayload, "utf8");
              } finally {
                fs2.closeSync(fd);
              }
              acquired = true;
              break;
            } catch (wxErr) {
              if (wxErr?.code !== "EEXIST") throw wxErr;
            }
          } else {
            throw err;
          }
        }
        if (isLockStale(lockPath) && tryReapDeadLock(entriesDir, key, lockPath)) {
          continue;
        }
        sleepSyncMs(12);
      }
    }
  } finally {
    try {
      fs2.unlinkSync(claimPath);
    } catch {
    }
  }
  if (!acquired) {
    throw new Error(`Timed out acquiring board lock for key "${key}" (${lockPath}).`);
  }
  try {
    return fn();
  } finally {
    try {
      const cur = fs2.readFileSync(lockPath, "utf8");
      if (cur.includes(nonce)) {
        fs2.unlinkSync(lockPath);
      }
    } catch {
    }
  }
}
function writeFileAtomic(filePath, content) {
  const dir = path2.dirname(filePath);
  const base = path2.basename(filePath);
  const tmpPath = path2.join(dir, `.${base}.tmp.${process.pid}.${crypto2.randomBytes(6).toString("hex")}`);
  let fd = null;
  try {
    fd = fs2.openSync(tmpPath, "wx", 384);
    fs2.writeFileSync(fd, content, "utf8");
    fs2.fsyncSync(fd);
    fs2.closeSync(fd);
    fd = null;
    fs2.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
    try {
      if (fs2.existsSync(tmpPath)) fs2.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
function yamlScalar(v) {
  return JSON.stringify(String(v ?? ""));
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
function serializeBoardEntry(entry) {
  const lines = [
    "---",
    "schema: 1",
    `key: ${yamlScalar(entry.key)}`,
    `title: ${yamlScalar(entry.title)}`,
    `updatedAt: ${yamlScalar(new Date(entry.updatedAt).toISOString())}`
  ];
  if (entry.source?.conversationId) {
    lines.push(`sourceClient: ${yamlScalar(entry.source.client)}`);
    lines.push(`sourceSession: ${yamlScalar(entry.source.conversationId)}`);
    if (typeof entry.source.step === "number" && Number.isFinite(entry.source.step) && entry.source.step >= 0) {
      lines.push(`sourceStep: ${Math.floor(entry.source.step)}`);
    }
  }
  lines.push("---", "", entry.body.trimEnd(), "");
  return lines.join("\n");
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
function formatBoardEntryBlock(entry, includeScopeBadge = false) {
  const scopeTag = includeScopeBadge && entry.scope.kind === "global" ? " [global]" : "";
  const titlePart = entry.title && entry.title !== entry.key ? ` \u2014 ${entry.title}` : "";
  const srcPart = entry.source?.conversationId ? ` \xB7 from ${entry.source.conversationId.slice(0, 8)}${entry.source.step !== void 0 ? `#${entry.source.step}` : ""}` : "";
  const iso = new Date(entry.updatedAt).toISOString().slice(0, 16).replace("T", " ");
  return `## ${entry.key}${scopeTag}${titlePart}
Meta: rev=${entry.revision} \xB7 updated=${iso}Z${srcPart}
Path: ${entry.filePath}
${entry.body}`;
}
function boardReadResult(opts) {
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const maxChars = Math.max(200, Math.min(8200, Math.floor(Number(opts.maxChars) || 8200)));
  const maxBytes = Math.min(8650, maxChars + 450);
  if (opts.scope.kind === "unresolved") {
    return {
      text: 'Error: Project scope is unresolved. Pass conversationId (from [agy-memory] startup header) or scope="global".',
      isError: true
    };
  }
  let entries = loadBoardEntries(opts.scope, boardsHome);
  if (opts.includeGlobal && opts.scope.kind !== "global") {
    entries = entries.concat(loadBoardEntries({ kind: "global" }, boardsHome));
    entries.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  }
  const wantedKeys = (opts.keys || []).map(normalizeBoardKey).filter(Boolean);
  if (wantedKeys.length > 0) {
    const keySet = new Set(wantedKeys);
    entries = entries.filter((e) => keySet.has(e.key));
  }
  const q = String(opts.query || "").trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    entries = entries.filter((e) => {
      const hay = `${e.key} ${e.title} ${e.body}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  const scopeLabel = formatScopeKey(opts.scope);
  if (entries.length === 0) {
    return {
      text: `Board empty for ${scopeLabel}${wantedKeys.length > 0 ? ` (keys: ${wantedKeys.join(", ")})` : ""}${q ? ` (query: "${opts.query}")` : ""}.`,
      isError: false
    };
  }
  const startOffset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const slice = entries.slice(startOffset);
  if (slice.length === 0) {
    return {
      text: `No entries at offset=${startOffset} (${entries.length} total entries in ${scopeLabel}).`,
      isError: false
    };
  }
  const header = `Project board (${scopeLabel}${opts.includeGlobal && opts.scope.kind !== "global" ? " + global" : ""}, ${entries.length} entry/entries):`;
  const blocks = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  let shownCount = 0;
  for (const entry of slice) {
    const block = `

${formatBoardEntryBlock(entry, Boolean(opts.includeGlobal))}`;
    const bBytes = Buffer.byteLength(block, "utf8");
    const reserveFooter = 180;
    if (shownCount > 0 && (usedBytes + bBytes + reserveFooter > maxBytes || blocks.join("").length + block.length + reserveFooter > maxChars)) {
      break;
    }
    if (shownCount === 0 && usedBytes + bBytes > maxBytes) {
      blocks.push(
        `

## ${entry.key} (exceeds inline budget: ${bBytes} B; read directly via read_file)
Meta: rev=${entry.revision}
Path: ${entry.filePath}`
      );
      shownCount += 1;
      break;
    }
    blocks.push(block);
    usedBytes += bBytes;
    shownCount += 1;
  }
  const remaining = slice.length - shownCount;
  if (remaining > 0) {
    blocks.push(`

(${remaining} more entry/entries omitted at entry boundary; call board_read with offset=${startOffset + shownCount}.)`);
  }
  return { text: blocks.join(""), isError: false };
}
function boardPostResult(opts) {
  if (opts.scope.kind === "unresolved") {
    return {
      text: 'Error: Project scope is unresolved. Pass conversationId (from [agy-memory] startup header) or scope="global" before mutating a board.',
      isError: true
    };
  }
  const key = normalizeBoardKey(opts.key);
  if (!isValidBoardKey(key)) {
    return {
      text: `Error: Invalid board key "${opts.key}". Use 1..64 lowercase ASCII letters, digits, '.', '_' or '-' starting with a letter or digit (e.g. "release-command").`,
      isError: true
    };
  }
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const entriesDir = getBoardEntriesDir(opts.scope, boardsHome);
  const entryPath = path2.join(entriesDir, `${key}.md`);
  const scopeLabel = formatScopeKey(opts.scope);
  const expectedRev = String(opts.expectedRevision || "").trim();
  try {
    return withPerKeyLock(entriesDir, key, () => {
      const existing = fs2.existsSync(entryPath) ? parseBoardEntryFile(entryPath, opts.scope) : null;
      if (opts.delete) {
        if (!existing) {
          return {
            text: `Error: Board key "${key}" does not exist in ${scopeLabel}.`,
            isError: true
          };
        }
        if (!expectedRev) {
          return {
            text: `Error: Deleting "${key}" requires expectedRevision="${existing.revision}" (call board_read first).`,
            isError: true
          };
        }
        if (existing.revision !== expectedRev) {
          return {
            text: `Error: Revision conflict deleting "${key}": expected "${expectedRev}", current is "${existing.revision}". Call board_read before retrying.`,
            isError: true
          };
        }
        fs2.unlinkSync(entryPath);
        return {
          text: `Removed board key "${key}" from ${scopeLabel} (previous rev=${existing.revision}).`,
          isError: false
        };
      }
      const body = String(opts.body ?? "").trim();
      if (!body) {
        return {
          text: `Error: body is required when creating or updating board key "${key}".`,
          isError: true
        };
      }
      if (existing) {
        if (!expectedRev) {
          return {
            text: `Error: Board key "${key}" already exists in ${scopeLabel} (current rev=${existing.revision}). Pass expectedRevision="${existing.revision}" to replace it.`,
            isError: true
          };
        }
        if (existing.revision !== expectedRev) {
          return {
            text: `Error: Revision conflict updating "${key}": expected "${expectedRev}", current is "${existing.revision}". Call board_read before retrying.`,
            isError: true
          };
        }
      } else if (expectedRev) {
        return {
          text: `Error: Board key "${key}" does not exist in ${scopeLabel}, so expectedRevision="${expectedRev}" cannot match.`,
          isError: true
        };
      }
      const title = String(opts.title ?? "").trim() || existing?.title || key;
      const updatedAt = Date.now();
      const serialized = serializeBoardEntry({
        key,
        title,
        body,
        updatedAt,
        source: opts.source
      });
      writeFileAtomic(entryPath, serialized);
      const saved = parseBoardEntryFile(entryPath, opts.scope);
      const verb = existing ? "Updated" : "Created";
      return {
        text: `${verb} board key "${saved.key}" in ${scopeLabel}
Revision: ${saved.revision}
Path: ${saved.filePath}`,
        isError: false
      };
    });
  } catch (err) {
    return {
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true
    };
  }
}
function migrateLegacyNotes(opts) {
  const details = [];
  let imported = 0;
  let skipped = 0;
  if (opts.targetScope.kind === "unresolved") {
    throw new Error("targetScope must be resolved before migrating notes.");
  }
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const topicsDir = path2.join(path2.resolve(opts.sourceDataDir), "memory", "topics");
  const legacyJson = path2.join(path2.resolve(opts.sourceDataDir), "plugin_data", "agy-memory", "notes.json");
  const candidates = [];
  if (fs2.existsSync(topicsDir)) {
    for (const fn of fs2.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort()) {
      const raw = fs2.readFileSync(path2.join(topicsDir, fn), "utf8").replace(/\r\n/g, "\n");
      const slug = normalizeBoardKey(path2.basename(fn, ".md").replace(/[^a-zA-Z0-9._-]/g, "-")).slice(0, 64);
      let title = slug;
      let body = raw.trim();
      let sourceSession = "";
      if (raw.startsWith("---\n")) {
        const end = raw.indexOf("\n---\n", 4);
        if (end > 0) {
          const fm = raw.slice(4, end);
          body = raw.slice(end + 5).trim();
          for (const line of fm.split("\n")) {
            const c = line.indexOf(":");
            if (c <= 0) continue;
            const k = line.slice(0, c).trim();
            const v = parseYamlScalar(line.slice(c + 1));
            if (k === "topic" && v) title = v;
            if (k === "sessionId" && v) sourceSession = v;
          }
        }
      }
      if (isValidBoardKey(slug) && body) {
        candidates.push({ key: slug, title, body, sourceSession });
      }
    }
  } else if (fs2.existsSync(legacyJson)) {
    try {
      const arr = JSON.parse(fs2.readFileSync(legacyJson, "utf8"));
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const rawId = String(item.id || item.topic || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
          const body = String(item.content || "").trim();
          if (isValidBoardKey(rawId) && body) {
            candidates.push({
              key: rawId,
              title: String(item.topic || rawId),
              body,
              sourceSession: String(item.sessionId || "")
            });
          }
        }
      }
    } catch {
      details.push(`Skipped unreadable legacy notes.json at ${legacyJson}`);
    }
  }
  for (const c of candidates) {
    const existingDir = getBoardEntriesDir(opts.targetScope, boardsHome);
    const existingPath = path2.join(existingDir, `${c.key}.md`);
    if (fs2.existsSync(existingPath)) {
      skipped += 1;
      details.push(`Skipped existing key "${c.key}"`);
      continue;
    }
    const res = boardPostResult({
      scope: opts.targetScope,
      key: c.key,
      title: c.title,
      body: c.body,
      boardsHome,
      source: c.sourceSession ? { client: "cli", conversationId: c.sourceSession } : void 0
    });
    if (!res.isError) {
      imported += 1;
      details.push(`Imported "${c.key}" -> ${formatScopeKey(opts.targetScope)}`);
    } else {
      skipped += 1;
      details.push(`Skipped "${c.key}": ${res.text}`);
    }
  }
  return { imported, skipped, details };
}

// src/store.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs3 from "node:fs";
import path3 from "node:path";
var TRUNCATION_SUFFIX = "\n\u2026 [truncated to fit inline budget]";
var MAX_TURN_CACHE_ENTRIES = 64;
var MAX_FULL_CACHE_ENTRIES = 32;
var MAX_DOC_CACHE_ENTRIES = 64;
var VALID_READ_MODES = /* @__PURE__ */ new Set(["digest", "turns", "artifacts", "swarm"]);
var catalogCache = /* @__PURE__ */ new Map();
var turnsCache = /* @__PURE__ */ new Map();
var fullStepsCache = /* @__PURE__ */ new Map();
var searchDocCache = /* @__PURE__ */ new Map();
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
    Number.isFinite(Number(maxChars)) ? Math.floor(maxChars) : 8200
  );
  const safeMaxBytes = Math.max(
    suffixBytes + 16,
    Number.isFinite(Number(maxBytes)) ? Math.floor(maxBytes) : 8650
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
function parseQueryTokens(query) {
  const text = String(query || "").trim();
  if (!text) return [];
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tok = (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (tok) tokens.push(tok);
  }
  return [...new Set(tokens)];
}
function cleanUserRequestText(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(s);
  if (reqMatch && reqMatch[1]) {
    s = reqMatch[1].trim();
  }
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "").trim();
  s = s.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, "").trim();
  return s;
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
function normalizeFsPath(rawPath) {
  const canon = normalizeCanonicalPath(rawPath);
  if (!canon) return "";
  return process.platform === "win32" || process.platform === "darwin" ? canon.toLowerCase() : canon;
}
function isTempPath(rawPath) {
  return isTempDirectory(rawPath);
}
function formatWorkspaceLabel(rawPath) {
  const trimmed = String(rawPath || "").trim();
  if (!trimmed) return "";
  if (isTempPath(trimmed)) return trimmed;
  const slashNorm = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return path3.posix.basename(slashNorm) || trimmed;
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
      return norm.startsWith(`${f}/`) || f.startsWith(`${norm}/`);
    }
    const lowNorm = norm.toLowerCase();
    const lowF = f.toLowerCase();
    const base = path3.posix.basename(lowNorm);
    return base === lowF || lowNorm.endsWith(`/${lowF}`) || lowNorm.includes(`/${lowF}/`);
  });
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
function listSessionArtifactFiles(brainDir, { includeMeta = false } = {}) {
  let entries;
  try {
    entries = fs3.readdirSync(brainDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith(".md") || name.endsWith(".resolved")) continue;
    const fullPath = path3.join(brainDir, name);
    let st;
    try {
      st = fs3.statSync(fullPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    let summary = "";
    let updatedAt = st.mtimeMs;
    if (includeMeta) {
      const metaPath = `${fullPath}.metadata.json`;
      try {
        const meta = JSON.parse(fs3.readFileSync(metaPath, "utf8"));
        if (meta && typeof meta.summary === "string") summary = meta.summary.trim();
        if (meta && meta.updatedAt) {
          const ts = Date.parse(meta.updatedAt);
          if (!Number.isNaN(ts)) updatedAt = ts;
        }
      } catch {
      }
    }
    out.push({ name, path: fullPath, summary, updatedAt, size: st.size });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
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
function resolveSessionEntry(overrideDir, sessionRef, catalog = null) {
  const rawRef = String(sessionRef || "").trim();
  if (!rawRef) return { entry: null, error: "sessionId is required." };
  const { client: explicitClient, id: bareRef } = splitClientRef(rawRef);
  const ref = bareRef.toLowerCase();
  const list = catalog || loadMultiClientCatalog(overrideDir).entries;
  const scoped = explicitClient ? list.filter((s) => s.client === explicitClient) : list;
  const exactMatches = scoped.filter((s) => s.sessionId.toLowerCase() === ref);
  if (exactMatches.length === 1) return { entry: exactMatches[0], error: null };
  if (exactMatches.length > 1) {
    const listStr = exactMatches.map((m) => `${m.canonicalId} (${m.title || "untitled"})`).join(", ");
    return { entry: null, error: `Ambiguous session ID "${sessionRef}"; qualify with client prefix: ${listStr}` };
  }
  if (ref.length < 4) {
    return { entry: null, error: `Session prefix "${sessionRef}" is too short (use at least 4 characters).` };
  }
  const matches = scoped.filter((s) => s.sessionId.toLowerCase().startsWith(ref));
  if (matches.length === 1) return { entry: matches[0], error: null };
  if (matches.length > 1) {
    const listStr = matches.slice(0, 5).map((m) => `${m.shortId} (${m.title || "untitled"})`).join(", ");
    return { entry: null, error: `Ambiguous session prefix "${sessionRef}"; matches: ${listStr}` };
  }
  return { entry: null, error: `No local conversation found matching "${sessionRef}".` };
}
function loadFullTranscriptStepMap(transcriptFullPath) {
  if (!transcriptFullPath || !fs3.existsSync(transcriptFullPath)) return null;
  const sig = statSignature(transcriptFullPath);
  const cached = fullStepsCache.get(transcriptFullPath);
  if (cached && cached.sig === sig) {
    return cached.stepMap;
  }
  let raw = "";
  try {
    raw = fs3.readFileSync(transcriptFullPath, "utf8");
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
      raw = fs3.readFileSync(transcriptPath, "utf8");
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
  if (!swarmBoardPath || !fs3.existsSync(swarmBoardPath)) return [];
  let raw = "";
  try {
    raw = fs3.readFileSync(swarmBoardPath, "utf8");
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
function getSearchableSessionDoc(entry, { includeFullTranscript = true, budget } = {}) {
  const cacheKey = entry.canonicalId;
  const transcriptSig = entry.hasTranscript ? statSignature(entry.paths.transcriptPath) : "none";
  const fullSig = includeFullTranscript && entry.hasTranscript && fs3.existsSync(entry.paths.transcriptFullPath) ? statSignature(entry.paths.transcriptFullPath) : "none";
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
      const st = fs3.statSync(entry.paths.transcriptPath);
      latestTranscriptMtimeMs = st.mtimeMs || 0;
      if (budget) budget.bytesRead += st.size;
    } catch (err) {
      latestTranscriptMtimeMs = 0;
      if (budget) {
        budget.incomplete = true;
        budget.reason = `transcript stat error (${err instanceof Error ? err.message : "stat failed"})`;
      }
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
      const content = fs3.readFileSync(art.path, "utf8");
      if (budget) budget.bytesRead += Buffer.byteLength(content, "utf8");
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
  return searchDocCache.has(entry.canonicalId);
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
    const membersObj = JSON.parse(fs3.readFileSync(entry.paths.swarmMembersPath, "utf8"));
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
  const reserveForSummaryAndFooter = 280;
  const headerText = headerLines.join("\n");
  const maxBodyChars = Math.max(400, safeMaxChars - headerText.length - reserveForSummaryAndFooter);
  const maxBodyBytes = Math.max(400, 8650 - Buffer.byteLength(headerText, "utf8") - reserveForSummaryAndFooter);
  const bodyClipLen = candidateSlice.length === 1 ? maxBodyChars : candidateSlice.length <= 4 ? Math.max(1600, Math.floor((maxBodyChars - candidateSlice.length * 90) / candidateSlice.length)) : candidateSlice.length <= 12 ? 900 : 480;
  const formatMsgBlock = (msg) => {
    const body = msg.text;
    const msgHeader = `
[#${msg.seq} ${msg.time || ""} \xB7 ${msg.agent}${msg.kind ? ` (${msg.kind})` : ""}]
`;
    const effectiveClip = Math.max(200, bodyClipLen - msgHeader.length);
    if (body.length <= effectiveClip) {
      return `${msgHeader}${body}`;
    }
    const hint = candidateSlice.length === 1 ? `\u2026 [clipped at ${effectiveClip}/${body.length} chars; full board: ${entry.paths.swarmBoardPath}]` : `\u2026 [clipped at ${effectiveClip}/${body.length} chars; pass startSeq=${msg.seq} endSeq=${msg.seq} for full message]`;
    return `${msgHeader}${safeSliceChars(body, Math.max(120, effectiveClip - hint.length))}${hint}`;
  };
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
        lineCount = splitFileLines(fs3.readFileSync(a.path, "utf8")).length;
      } catch {
      }
      out.push(`- ${a.name} (${lineCount} lines, ${a.size} B) \u2014 Path: ${a.path}`);
      if (a.summary) out.push(`  ${(a.summary.split("\n")[0] ?? "").slice(0, 180)}`);
    }
    out.push(
      "\nTip: For full reads of large Markdown artifacts (>100 lines), call built-in read_file(Path) directly or pass artifactName + startLine/endLine."
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
  const allLines = splitFileLines(fs3.readFileSync(target.path, "utf8"));
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
    dataDir = "",
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
  const { entry, error } = resolveSessionEntry(dataDir, sessionId, null);
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
    `Session: ${entry.sessionId} (client=${entry.client}, scope=${formatScopeKey(entry.scopeKey)})`,
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
      const m = JSON.parse(fs3.readFileSync(entry.paths.swarmMembersPath, "utf8"));
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
          const replySignal = Math.min(40, Math.floor(t.finalAssistantText.length / 40));
          const toolSignal = Math.min(30, t.tools.length * 3);
          const signal = (t.userText ? 15 : 0) + replySignal + toolSignal;
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

// src/search.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import fs6 from "node:fs";

// src/stream.ts
import fs4 from "node:fs";
import path4 from "node:path";
var CHUNK_BYTES = 64 * 1024;
function createScanBudget(maxScanBytes = 32 * 1024 * 1024, maxScanMs = 2500) {
  return {
    maxScanBytes,
    maxScanMs,
    startedAtMs: Date.now(),
    bytesRead: 0,
    sessionsScanned: 0,
    incomplete: false,
    reason: ""
  };
}
function checkScanBudget(budget) {
  if (!budget) return true;
  if (budget.incomplete) return false;
  if (budget.bytesRead >= budget.maxScanBytes) {
    budget.incomplete = true;
    budget.reason = `byte budget (${Math.round(budget.maxScanBytes / (1024 * 1024))} MB) reached`;
    return false;
  }
  if (Date.now() - budget.startedAtMs >= budget.maxScanMs) {
    budget.incomplete = true;
    budget.reason = `time budget (${budget.maxScanMs} ms) reached`;
    return false;
  }
  return true;
}
function streamJsonlFromOffset(filePath, startOffset, onLine, budget) {
  let fd = null;
  try {
    fd = fs4.openSync(filePath, "r");
    const st = fs4.fstatSync(fd);
    const size = st.size;
    const mtimeMs = st.mtimeMs;
    let pos = Math.max(0, startOffset);
    if (pos >= size) {
      return { newOffset: size, eof: true, size, mtimeMs, ioError: false };
    }
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carryParts = [];
    let carryLen = 0;
    let consumedBytes = pos;
    while (pos < size) {
      if (budget && !checkScanBudget(budget)) {
        return { newOffset: consumedBytes, eof: false, size, mtimeMs, ioError: false };
      }
      const remainingBudget = budget ? Math.max(1, budget.maxScanBytes - budget.bytesRead) : CHUNK_BYTES;
      const toRead = Math.min(CHUNK_BYTES, size - pos, remainingBudget);
      const n = fs4.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      pos += n;
      if (budget) budget.bytesRead += n;
      const slice = buf.subarray(0, n);
      let segStart = 0;
      for (let i = 0; i < n; i += 1) {
        if (slice[i] === 10) {
          let lineBuf;
          const tailSlice = slice.subarray(segStart, i);
          if (carryLen > 0) {
            carryParts.push(tailSlice);
            lineBuf = Buffer.concat(carryParts, carryLen + tailSlice.length);
            carryParts = [];
            carryLen = 0;
          } else {
            lineBuf = tailSlice;
          }
          consumedBytes += lineBuf.length + 1;
          segStart = i + 1;
          const line = lineBuf.toString("utf8").trim();
          if (line) onLine(line);
        }
      }
      if (segStart < n) {
        const rem = Buffer.from(slice.subarray(segStart));
        carryParts.push(rem);
        carryLen += rem.length;
      }
    }
    if (carryLen > 0 && pos >= size) {
      const trailing = Buffer.concat(carryParts, carryLen);
      const trimmed = trailing.toString("utf8").trim();
      if (trimmed) {
        let validJson = false;
        try {
          JSON.parse(trimmed);
          validJson = true;
        } catch {
          validJson = false;
        }
        if (validJson) {
          consumedBytes += carryLen;
          onLine(trimmed);
        }
      } else {
        consumedBytes += carryLen;
      }
    }
    return { newOffset: consumedBytes, eof: pos >= size, size, mtimeMs, ioError: false };
  } catch (err) {
    if (budget) {
      budget.incomplete = true;
      budget.reason = `I/O read error (${err instanceof Error ? err.message : "read failed"})`;
    }
    return { newOffset: startOffset, eof: false, size: 0, mtimeMs: 0, ioError: true };
  } finally {
    if (fd !== null) {
      try {
        fs4.closeSync(fd);
      } catch {
      }
    }
  }
}
function resolveToolPath(rawPath, primaryWorkspace) {
  const cleaned = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return { rawPath: "", resolvedPath: "", basename: "" };
  const isWin = /^[a-zA-Z]:[\\/]/.test(cleaned) || /^[a-zA-Z]:[\\/]/.test(primaryWorkspace);
  const pathImpl = isWin ? path4.win32 : path4.posix;
  let resolved = cleaned;
  if (!pathImpl.isAbsolute(cleaned) && primaryWorkspace) {
    resolved = pathImpl.resolve(primaryWorkspace, cleaned);
  } else {
    resolved = pathImpl.normalize(cleaned);
  }
  const normalized = resolved.replace(/\\/g, "/");
  const basename = path4.posix.basename(normalized);
  return { rawPath: cleaned, resolvedPath: normalized, basename };
}

// src/trace.ts
import fs5 from "node:fs";
import path5 from "node:path";
var MAX_TRACE_CACHE = 48;
var IS_WIN = process.platform === "win32";
var SINGLE_WRITE_TOOLS = /* @__PURE__ */ new Set([
  "edit_file",
  "write_file",
  "replace_file_content",
  "multi_replace_file_content",
  "write_to_file"
]);
var SINGLE_READ_TOOLS = /* @__PURE__ */ new Set(["read_file", "view_file"]);
var agyTraceCache = /* @__PURE__ */ new Map();
function lruPutTrace(key, val) {
  if (agyTraceCache.has(key)) agyTraceCache.delete(key);
  agyTraceCache.set(key, val);
  while (agyTraceCache.size > MAX_TRACE_CACHE) {
    const first = agyTraceCache.keys().next().value;
    if (first === void 0) break;
    agyTraceCache.delete(first);
  }
}
function unwrapArgValue(v) {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("[") && trimmed.endsWith("]") || trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
}
function parseArgsRecord(raw) {
  let obj = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw;
  } else if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      obj = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = unwrapArgValue(v);
  }
  return out;
}
function extractFileToolPaths(toolName, args) {
  const low = toolName.toLowerCase();
  const out = [];
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const pushPath = (raw, isWrite) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const val = raw.trim();
    const joined = cwd && !path5.isAbsolute(val) && !/^[a-zA-Z]:[\\/]/.test(val) ? path5.posix.join(cwd.replace(/\\/g, "/"), val) : val;
    out.push({ path: joined, isWrite });
  };
  if (SINGLE_WRITE_TOOLS.has(low)) {
    pushPath(args.Path ?? args.TargetFile ?? args.path, true);
    return out;
  }
  if (low === "apply_edits" || low.endsWith("_apply_edits")) {
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (e && typeof e === "object") pushPath(e.path, true);
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
        if (s && typeof s === "object") pushPath(s.path, false);
      }
    }
    return out;
  }
  return out;
}
function stripTimestampHeader(text) {
  return text.replace(/^(?:(?:Created At|Completed At):\s*[^\n]+\n?)+/gi, "").replace(/\s+/g, " ").trim();
}
function isLikelyToolResponse(rawGeneric) {
  if (!rawGeneric.trim()) return false;
  if (/^(?:Created At|Completed At):/i.test(rawGeneric)) return true;
  if (/^(?:Made \d+ replacement|Created file\.|Appended to file\.|Overwrote file\.|Showing lines |Command exited with code|The tool's output was truncated|Successfully |Encountered error in tool execution|Error:|Applied \d+ edit)/i.test(
    rawGeneric.trim()
  )) {
    return true;
  }
  if (/^<(?:SYSTEM_MESSAGE|USER_REQUEST|CONTEXT_SUMMARY)/i.test(rawGeneric.trim())) return false;
  return true;
}
function parseGenericOutcome(content) {
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
  if (/Encountered error in tool execution|Partial edit applied|\[FAIL\b|ERR_ASSERTION|\bTarget (?:string |text )?not found\b|\bFile already exists\b|\bPermission denied\b|^Error:/i.test(
    cleaned
  )) {
    return { status: "failed", exitCode: null, snippet: cleaned.slice(0, 260) };
  }
  if (/^(?:Made \d+ replacement|Created file\.|Appended to file\.|Overwrote file\.|Successfully (?:edited|wrote|created|applied)|Applied \d+ edit|Edited \d+ file|All \d+ edit|OK\b)/i.test(
    cleaned
  ) || /\b(?:applied|edited|created)\s+\d+\s+file/i.test(cleaned)) {
    return { status: "succeeded", exitCode: null, snippet: "" };
  }
  return { status: "unverified", exitCode: null, snippet: "" };
}
function buildFullCommandKey(cmdLine, cwd) {
  const compactCmd = String(cmdLine || "").replace(/\s+/g, " ").trim();
  const compactCwd = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
  return compactCwd ? `${compactCwd}::${compactCmd}` : compactCmd;
}
function pickMatchingPendingCall(batch, cleanedOutput) {
  if (batch.length === 0) return void 0;
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
function extractSessionTraceDoc(entry, budget) {
  const filePath = entry.paths.transcriptPath;
  let st;
  try {
    st = fs5.statSync(filePath);
  } catch (err) {
    if (budget) {
      budget.incomplete = true;
      budget.reason = `transcript stat error (${err instanceof Error ? err.message : "stat failed"})`;
    }
    return { fileEvents: [], errorEvents: [], passEvents: [] };
  }
  const cached = agyTraceCache.get(filePath);
  let state;
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
      pendingBatch: []
    };
  }
  const primaryWs = entry.workspaces[0] || "";
  const flushNextWithOutcome = (resultStepIndex, genericContent) => {
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
      const fileOutcome = ph.isWrite ? outcome.status === "failed" ? "write_failed" : outcome.status === "succeeded" ? "write_succeeded" : "write_unverified" : "read";
      state.doc.fileEvents.push({
        stepIndex: call.stepIndex,
        date: call.date,
        toolName: call.name,
        rawPath: norm.rawPath,
        resolvedPath: norm.resolvedPath,
        basename: norm.basename,
        outcome: fileOutcome,
        userPrompt: state.lastUser.slice(0, 140),
        assistantSnippet: state.lastAssistant.slice(0, 180)
      });
    }
    const cmdLine = String(call.args.CommandLine || call.args.command || "").trim();
    const cmdCwd = String(call.args.Cwd || call.args.cwd || primaryWs || "").trim();
    const lowName = call.name.toLowerCase();
    const isCmd = lowName === "run_command" || lowName.endsWith("_run_checks");
    const invocation = cmdLine ? cmdLine.split(/\r?\n/)[0].slice(0, 160) : pathHits[0] ? `${call.name} ${pathHits[0].path}` : call.name;
    const cmdKey = cmdLine ? buildFullCommandKey(cmdLine, cmdCwd) : `${lowName}:${pathHits[0]?.path || ""}`;
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
        userPrompt: state.lastUser.slice(0, 140)
      });
    } else if (isCmd && outcome.status === "succeeded" && outcome.exitCode === 0) {
      state.doc.passEvents.push({
        stepIndex: call.stepIndex,
        date: call.date,
        toolName: call.name,
        invocation,
        commandKey: cmdKey
      });
    }
  };
  const res = streamJsonlFromOffset(
    filePath,
    startOffset,
    (line) => {
      let step;
      try {
        step = JSON.parse(line);
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
            const ev = state.doc.fileEvents[i];
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
              args: parseArgsRecord(tc.arguments ?? tc.args)
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
    budget
  );
  if (!res.ioError) {
    lruPutTrace(filePath, {
      offset: res.newOffset,
      eof: res.eof,
      mtimeMs: res.mtimeMs,
      size: res.size,
      state
    });
  }
  return state.doc;
}
function normalizeForMatch(p) {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return IS_WIN ? norm.toLowerCase() : norm;
}
function matchesTargetFile(ev, queryNorm, isBasenameQuery) {
  const resNorm = normalizeForMatch(ev.resolvedPath);
  const baseNorm = IS_WIN ? ev.basename.toLowerCase() : ev.basename;
  if (isBasenameQuery) {
    return baseNorm === queryNorm || resNorm.endsWith(`/${queryNorm}`);
  }
  return resNorm === queryNorm || resNorm.endsWith(`/${queryNorm}`);
}
function runFileHistorySearch(opts) {
  const { eligible, query, coverageLabel, maxSessions, maxChars } = opts;
  const cleanQuery = String(query || "").trim().replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (!cleanQuery) {
    return { text: "Error: query (file path or filename) is required for mode='file_history'.", isError: true };
  }
  const queryNorm = normalizeForMatch(cleanQuery);
  const isBasenameQuery = !queryNorm.includes("/");
  const budget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();
  const hits = [];
  const distinctPaths = /* @__PURE__ */ new Map();
  for (const entry of eligible) {
    if (!checkScanBudget(budget)) break;
    budget.sessionsScanned += 1;
    const doc = extractSessionTraceDoc(entry, budget);
    const matched = doc.fileEvents.filter((ev) => matchesTargetFile(ev, queryNorm, isBasenameQuery));
    if (matched.length === 0) continue;
    const writes = [];
    const failedWrites = [];
    const unverifiedWrites = [];
    const reads = [];
    const resolvedPaths = /* @__PURE__ */ new Set();
    for (const ev of matched) {
      resolvedPaths.add(ev.resolvedPath);
      const stat = distinctPaths.get(ev.resolvedPath) || { sessions: /* @__PURE__ */ new Set(), writes: 0, reads: 0 };
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
  const coverageBanner = budget.incomplete ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${eligible.length} sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays \u2014 do NOT treat 0-match as authoritative).` : `Complete scan: ${budget.sessionsScanned}/${eligible.length} sessions (${coverageLabel}).`;
  if (hits.length === 0) {
    return {
      text: `No file tool history matched "${cleanQuery}".
${coverageBanner}`,
      isError: false
    };
  }
  hits.sort((a, b) => {
    const aRank = a.writes.length > 0 ? 2 : a.unverifiedWrites.length > 0 ? 1 : 0;
    const bRank = b.writes.length > 0 ? 2 : b.unverifiedWrites.length > 0 ? 1 : 0;
    if (bRank !== aRank) return bRank - aRank;
    return b.entry.updatedMs - a.entry.updatedMs;
  });
  const lines = [
    `File history for "${cleanQuery}" \u2014 ${hits.length} session(s) (showing top ${Math.min(hits.length, maxSessions)}):`,
    coverageBanner
  ];
  if (isBasenameQuery && distinctPaths.size > 1) {
    lines.push(
      `
Disambiguation: "${cleanQuery}" matched ${distinctPaths.size} distinct resolved paths (pass a relative/full path to narrow):`
    );
    const rankedPaths = [...distinctPaths.entries()].sort(
      (a, b) => b[1].writes - a[1].writes || b[1].sessions.size - a[1].sessions.size
    );
    for (const [rp, info] of rankedPaths.slice(0, 6)) {
      lines.push(`- ${rp} (${info.sessions.size} session(s), ${info.writes} write_succeeded, ${info.reads} read)`);
    }
  }
  for (const h of hits.slice(0, maxSessions)) {
    const e = h.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
    lines.push(
      `
### ${e.shortId} \u2014 ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`
    );
    lines.push(`ID: ${e.sessionId}`);
    lines.push(`Paths: ${[...h.resolvedPaths].slice(0, 3).join(", ")}`);
    const unvPart = h.unverifiedWrites.length > 0 ? `, ${h.unverifiedWrites.length} write_unverified` : "";
    lines.push(
      `Actions: ${h.writes.length} write_succeeded, ${h.failedWrites.length} write_failed${unvPart}, ${h.reads.length} read`
    );
    const exemplar = h.writes[h.writes.length - 1] || h.unverifiedWrites[0] || h.failedWrites[0] || h.reads[0];
    const steps = [...new Set([...h.writes, ...h.unverifiedWrites, ...h.failedWrites].map((x) => `#${x.stepIndex}`))].slice(-6);
    if (steps.length > 0) {
      lines.push(
        `Write steps: ${steps.join(", ")} (use read_session(sessionId="${e.shortId}", mode="turns", startStep, endStep) for verbatim context)`
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
function runErrorHistorySearch(opts) {
  const { eligible, query, coverageLabel, maxSessions, maxChars } = opts;
  const terms = parseQueryTokens(query);
  if (terms.length === 0) {
    return { text: "Error: query (error pattern or command keyword) is required for mode='error_history'.", isError: true };
  }
  const budget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();
  const hits = [];
  for (const entry of eligible) {
    if (!checkScanBudget(budget)) break;
    budget.sessionsScanned += 1;
    const doc = extractSessionTraceDoc(entry, budget);
    if (doc.errorEvents.length === 0) continue;
    const matchedItems = [];
    for (const err of doc.errorEvents) {
      const hay = `${err.toolName} ${err.invocation} ${err.errorSnippet} ${err.userPrompt}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const subsequentWrites = doc.fileEvents.filter((f) => f.outcome === "write_succeeded" && f.stepIndex > err.stepIndex).slice(0, 5);
      const matchingPass = doc.passEvents.find((p) => p.stepIndex > err.stepIndex && p.commandKey === err.commandKey) || null;
      matchedItems.push({ err, subsequentWrites, matchingPass });
    }
    if (matchedItems.length > 0) {
      hits.push({ entry, items: matchedItems.slice(-3) });
    }
  }
  const coverageBanner = budget.incomplete ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${eligible.length} sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays \u2014 do NOT treat 0-match as authoritative).` : `Complete scan: ${budget.sessionsScanned}/${eligible.length} sessions (${coverageLabel}).`;
  if (hits.length === 0) {
    return {
      text: `No failed tool/command history matched "${query}".
${coverageBanner}`,
      isError: false
    };
  }
  hits.sort((a, b) => b.entry.updatedMs - a.entry.updatedMs);
  const lines = [
    `Error history for "${query}" \u2014 ${hits.length} session(s) (showing top ${Math.min(hits.length, maxSessions)}):`,
    coverageBanner
  ];
  for (const h of hits.slice(0, maxSessions)) {
    const e = h.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
    lines.push(
      `
### ${e.shortId} \u2014 ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`
    );
    lines.push(`ID: ${e.sessionId}`);
    for (const item of h.items) {
      const exitTag = item.err.exitCode !== null ? ` exit=${item.err.exitCode}` : "";
      lines.push(`- [failing invocation #${item.err.stepIndex}\u2192#${item.err.resultStepIndex}${exitTag}] ${item.err.invocation}`);
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

// src/search.ts
var RG_CANDIDATES = process.platform === "win32" ? ["rg", "rg.exe"] : ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
var VALID_SCOPES = /* @__PURE__ */ new Set(["all", "user", "assistant", "artifacts", "swarm"]);
var VALID_SEARCH_MODES = /* @__PURE__ */ new Set(["text", "file_history", "error_history"]);
var IN_FLIGHT_WINDOW_MS = 180 * 1e3;
var JSON_ESCAPED_CHAR_RE = /["\\<>&\n\r\t]/;
var CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
function parseSearchQuery(rawQuery, isRegex) {
  const text = String(rawQuery || "").trim();
  if (!text) return { terms: [], regex: null, error: null };
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
  const registerFile = (filePath, canonicalId) => {
    files.push(filePath);
    fileToSession.set(normalizeFsPath(filePath), canonicalId);
  };
  for (const entry of entries) {
    if (wantTranscript && entry.hasTranscript) {
      registerFile(entry.paths.transcriptPath, entry.canonicalId);
      if (entry.paths.transcriptFullPath && fs6.existsSync(entry.paths.transcriptFullPath)) {
        registerFile(entry.paths.transcriptFullPath, entry.canonicalId);
      }
    }
    if (wantArtifacts) {
      const arts = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: false });
      for (const art of arts) {
        registerFile(art.path, entry.canonicalId);
      }
    }
    if (wantSwarm && entry.hasSwarm && entry.paths.swarmBoardPath && fs6.existsSync(entry.paths.swarmBoardPath)) {
      registerFile(entry.paths.swarmBoardPath, entry.canonicalId);
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
        const stdout = execFileSync3(rgBin, args, {
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
        if (nearExisting) effective -= 2;
        const distinctSource = selected.every((picked) => picked.sourceKind !== cand.sourceKind);
        if (distinctSource) effective += 1.2;
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
  skipInFlightSelfPrompt,
  budget
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
  const doc = getSearchableSessionDoc(entry, { includeFullTranscript: true, budget });
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
function formatListedSessions(eligible, opts) {
  const shown = eligible.slice(0, opts.maxSessions);
  const scopeNote = opts.scopeFilter ? `scope=${formatScopeKey(opts.scopeFilter)}` : `clients=${opts.coverageLabel}`;
  const wsNote = opts.workspace ? `, workspace~"${opts.workspace}"` : "";
  if (shown.length === 0) {
    return {
      text: `No matching conversations found (${scopeNote}${wsNote}).`,
      isError: false
    };
  }
  const lines = [`Recent conversations (${shown.length} of ${eligible.length} shown; ${scopeNote}${wsNote}):`, ""];
  for (const s of shown) {
    const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
    const wsName = s.workspaces[0] ? formatWorkspaceLabel(s.workspaces[0]) : "";
    const badges = [];
    if (s.notFullyIdle) badges.push("active");
    if (s.hasSwarm) badges.push("swarm");
    if (artifacts.length > 0) badges.push(`${artifacts.length} artifacts`);
    if (s.isChild) badges.push("child");
    const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const title = s.title || "(untitled)";
    const meta = [
      formatShortDate(s.updatedMs),
      formatRelativeTime(s.updatedMs, opts.now),
      s.client,
      wsName,
      s.stepCount > 0 ? `${s.stepCount} steps` : ""
    ].filter(Boolean).join(" \xB7 ");
    lines.push(`- **${s.shortId}** (${s.sessionId}) \u2014 ${title}${badgeStr}`);
    lines.push(`  ${meta}`);
    if (s.preview && s.preview !== s.title) {
      lines.push(`  Preview: ${safeSliceChars(s.preview.replace(/\s+/g, " ").trim(), 140)}`);
    }
  }
  return { text: truncateUtf8(lines.join("\n"), opts.maxChars), isError: false };
}
function searchSessionsResult(opts = {}) {
  const {
    dataDir = "",
    query = "",
    mode = "text",
    scope = "all",
    regex: isRegex = false,
    conversationId = "",
    scopeKey: explicitScopeStr = "",
    allScopes = false,
    workspace = "",
    sessionId = "",
    includeChildren = false,
    excludeSessionId = "",
    sinceDays = 0,
    maxSessions = 10,
    maxSnippetsPerSession = 3,
    maxChars = 8200,
    maxScanBytes,
    maxScanMs
  } = opts;
  const safeMode = String(mode || "text").trim().toLowerCase();
  if (!VALID_SEARCH_MODES.has(safeMode)) {
    return {
      text: `Error: Invalid mode "${mode}". Expected one of: text, file_history, error_history.`,
      isError: true
    };
  }
  const targetSessionRef = String(sessionId || "").trim();
  const safeMaxSessions = Math.max(1, Math.min(25, Number(maxSessions) || 10));
  const safeMaxSnippets = Math.max(1, Math.min(8, Number(maxSnippetsPerSession) || 3));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const { entries: catalog, coverageLabel } = loadMultiClientCatalog(dataDir);
  const now = Date.now();
  const minMs = sinceDays > 0 ? now - sinceDays * 24 * 3600 * 1e3 : 0;
  let activeScopeFilter = null;
  let effectiveExclude = excludeSessionId;
  if (!allScopes) {
    if (explicitScopeStr.trim()) {
      const parsed2 = parseExplicitScopeKey(explicitScopeStr);
      if (!parsed2 || parsed2.kind === "global") {
        return { text: `Error: Invalid scopeKey "${explicitScopeStr}".`, isError: true };
      }
      activeScopeFilter = parsed2;
    } else if (conversationId.trim()) {
      const ctx = resolveConversationContext({
        conversationId: conversationId.trim(),
        overrideDataDir: dataDir,
        catalog
      });
      if (ctx.scopeKey.kind === "unresolved") {
        return {
          text: `Error: Could not resolve project scope for conversation "${conversationId}"${ctx.diagnostic ? ` (${ctx.diagnostic})` : ""}. Pass allScopes=true or workspace to search without project scoping.`,
          isError: true
        };
      }
      activeScopeFilter = ctx.scopeKey;
      if (!targetSessionRef) {
        effectiveExclude = effectiveExclude ? `${effectiveExclude},${conversationId.trim()}` : conversationId.trim();
      }
    } else if (!targetSessionRef && !workspace.trim()) {
      return {
        text: "Error: Pass conversationId (from [agy-memory] startup header) to stay scoped to your project, or set allScopes=true to search across all projects.",
        isError: true
      };
    }
  }
  let eligible;
  if (targetSessionRef) {
    const resolved = resolveSessionEntry(dataDir, targetSessionRef, catalog);
    if (!resolved.entry) {
      return { text: `Error: ${resolved.error || `No conversation matched "${targetSessionRef}".`}`, isError: true };
    }
    const s = resolved.entry;
    const scopeMismatch = activeScopeFilter !== null && !scopeKeysEqual(s.scopeKey, activeScopeFilter);
    const excluded = scopeMismatch || effectiveExclude && matchesSessionId(s.sessionId, effectiveExclude, s.client) || minMs > 0 && s.updatedMs < minMs || !workspaceMatches(s.workspaces, workspace);
    eligible = excluded ? [] : [s];
  } else {
    eligible = catalog.filter((s) => {
      if (!includeChildren && s.isChild) return false;
      if (activeScopeFilter && !scopeKeysEqual(s.scopeKey, activeScopeFilter)) return false;
      if (effectiveExclude && matchesSessionId(s.sessionId, effectiveExclude, s.client)) return false;
      if (minMs > 0 && s.updatedMs < minMs) return false;
      if (!workspaceMatches(s.workspaces, workspace)) return false;
      return true;
    });
  }
  if (safeMode === "file_history") {
    return runFileHistorySearch({
      eligible,
      query,
      coverageLabel,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      maxScanBytes,
      maxScanMs
    });
  }
  if (safeMode === "error_history") {
    return runErrorHistorySearch({
      eligible,
      query,
      coverageLabel,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      maxScanBytes,
      maxScanMs
    });
  }
  if (!String(query || "").trim()) {
    return formatListedSessions(eligible, {
      coverageLabel,
      scopeFilter: activeScopeFilter,
      workspace,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      now
    });
  }
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
  if (terms.length === 0) {
    return formatListedSessions(eligible, {
      coverageLabel,
      scopeFilter: activeScopeFilter,
      workspace,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      now
    });
  }
  const budget = createScanBudget(maxScanBytes, maxScanMs);
  const hasJsonSpecial = terms.some((t) => JSON_ESCAPED_CHAR_RE.test(t));
  const uncachedEntries = eligible.filter((s) => !isSessionDocCached(s));
  let toScan = eligible;
  if (!targetSessionRef && !regex && uncachedEntries.length > 0 && !hasJsonSpecial) {
    let remainingUncached = uncachedEntries;
    const seedList = rankSeedTerms(terms).slice(0, 3);
    let rgFailed = false;
    const checkArtifactNames = safeScope === "all" || safeScope === "artifacts";
    for (const seedTerm of seedList) {
      if (remainingUncached.length === 0) break;
      const rgMatchedIds = findMatchingSessionsWithRg(remainingUncached, seedTerm, false, safeScope);
      if (!(rgMatchedIds instanceof Set)) {
        rgFailed = true;
        break;
      }
      remainingUncached = remainingUncached.filter((s) => {
        if (rgMatchedIds.has(s.canonicalId)) return true;
        if (safeScope === "all") {
          const lowTitle = `${s.title} ${s.preview}`.trim().toLowerCase();
          if (lowTitle.includes(seedTerm)) return true;
        }
        if (checkArtifactNames) {
          const arts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
          if (arts.some((a) => a.name.toLowerCase().includes(seedTerm))) return true;
        }
        return false;
      });
      if (remainingUncached.length <= 3) break;
    }
    if (!rgFailed) {
      const keptUncached = new Set(remainingUncached.map((s) => s.canonicalId));
      toScan = eligible.filter((s) => isSessionDocCached(s) || keptUncached.has(s.canonicalId));
    }
  }
  const skipInFlightSelfPrompt = !targetSessionRef;
  const results = [];
  let skippedInFlightCount = 0;
  for (const entry of toScan) {
    if (!checkScanBudget(budget)) break;
    budget.sessionsScanned += 1;
    const { hit, skippedInFlight } = scanSessionDoc(entry, {
      scope: safeScope,
      terms,
      regex,
      maxSnippets: safeMaxSnippets,
      now,
      skipInFlightSelfPrompt,
      budget
    });
    if (skippedInFlight) skippedInFlightCount += 1;
    if (hit) results.push(hit);
  }
  results.sort((a, b) => b.score - a.score || b.entry.updatedMs - a.entry.updatedMs);
  const top = results.slice(0, safeMaxSessions);
  const incompleteNote = budget.incomplete ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${toScan.length} candidates, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays \u2014 do NOT treat 0-match as authoritative).` : "";
  const scopeDesc = activeScopeFilter ? `projectScope=${formatScopeKey(activeScopeFilter)}` : `clients=${coverageLabel}`;
  if (top.length === 0) {
    const scopeLabel = safeScope === "all" ? "transcripts, artifacts, and swarm boards" : safeScope;
    const filters = [];
    if (activeScopeFilter) filters.push(`projectScope=${formatScopeKey(activeScopeFilter)}`);
    if (workspace) filters.push(`workspace~"${workspace}"`);
    if (targetSessionRef) filters.push(`sessionId="${targetSessionRef}"`);
    if (skippedInFlightCount > 0) filters.push("excluded active in-flight prompt");
    const filterSuffix = filters.length > 0 ? `; ${filters.join(", ")}` : "";
    const statusLine = incompleteNote ? `
${incompleteNote}` : `
Complete scan (${eligible.length} eligible session(s), ${coverageLabel}).
Note: text mode searches user/assistant replies, artifacts, and Swarm only; for failed commands/exit codes or tool file edits, try mode="error_history" or mode="file_history".`;
    return {
      text: `No past conversations matched "${query}" (searched ${eligible.length} session(s) [${scopeDesc}] across ${scopeLabel}${filterSuffix}).${statusLine}`,
      isError: false
    };
  }
  const lines = [
    `Search "${query}" \u2014 ${results.length} matching conversation(s) (showing top ${top.length}, scope=${safeScope}, ${scopeDesc}${targetSessionRef ? `, session=${targetSessionRef}` : ""}):`
  ];
  if (incompleteNote) lines.push(incompleteNote);
  for (const r of top) {
    const e = r.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
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
var READ_ONLY_LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
var TOOL_DEFINITIONS = [
  {
    name: "board_read",
    description: "Read active Project Blackboard entries (decisions, conventions, handoffs) with revisions, source sessions, and paths. Local read-only.",
    annotations: { title: "Read Project Blackboard", ...READ_ONLY_LOCAL },
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "Current session UUID from [agy-memory] header." },
        scope: { type: "string", default: "all", description: "'all' (project+global), 'project', 'global', or explicit scope key." },
        keys: { type: "array", items: { type: "string" }, description: "Optional entry keys to fetch." },
        query: { type: "string", description: "Optional AND filter." },
        offset: { type: "integer", minimum: 0, description: "Entry paging offset." },
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." }
      }
    }
  },
  {
    name: "board_post",
    description: "Create, replace, or delete one keyed Project Blackboard entry (entries/<key>.md). Updates and deletes require expectedRevision.",
    annotations: {
      title: "Update Project Blackboard",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
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
        delete: { type: "boolean", default: false, description: "Set true with expectedRevision to remove entry." }
      },
      required: ["key"]
    }
  },
  {
    name: "search_sessions",
    description: "List or search local Antigravity sessions (App/CLI/IDE). Omit query to list. Modes: 'text' (replies/artifacts/Swarm), 'file_history' (writes vs reads), 'error_history' (failed commands/tests \u2014 use even with a filename). Pass conversationId to scope to current project or allScopes=true for all projects.",
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
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." }
      }
    }
  },
  {
    name: "read_session",
    description: "Read one local Antigravity session by UUID or prefix (>=4 chars): 'digest', 'turns' (hydrated, charOffset paging), 'artifacts', or 'swarm' (newest-first).",
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
        maxChars: { type: "integer", minimum: 200, maximum: 8200, description: "Char cap (default 8200)." }
      },
      required: ["sessionId"]
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
function resolveBoardToolScope(opts) {
  const scopeStr = opts.rawScope.trim() || opts.defaultScope;
  const cid = opts.conversationId.trim();
  if (scopeStr === "global") {
    const source = cid ? { client: "cli", conversationId: cid } : void 0;
    return { scope: { kind: "global" }, includeGlobal: false, source };
  }
  const explicit = parseExplicitScopeKey(scopeStr);
  if (explicit) {
    let source;
    if (cid) {
      const ctx2 = resolveConversationContext({ conversationId: cid, overrideDataDir: opts.dataDir });
      source = { client: ctx2.scopeKey.kind !== "unresolved" ? ctx2.client : "cli", conversationId: cid };
    }
    return { scope: explicit, includeGlobal: false, source };
  }
  if (scopeStr !== "project" && scopeStr !== "all") {
    return {
      scope: { kind: "unresolved" },
      includeGlobal: false,
      error: `Error: Invalid scope "${scopeStr}". Expected "project", "global", "all", or an explicit scope key.`
    };
  }
  if (!cid) {
    return {
      scope: { kind: "unresolved" },
      includeGlobal: false,
      error: 'Error: Pass conversationId (from [agy-memory] startup header) or scope="global" so board access stays isolated to the right project.'
    };
  }
  const ctx = resolveConversationContext({ conversationId: cid, overrideDataDir: opts.dataDir });
  if (ctx.scopeKey.kind === "unresolved") {
    return {
      scope: ctx.scopeKey,
      includeGlobal: false,
      error: `Error: Could not resolve project scope for conversation "${cid}"${ctx.diagnostic ? ` (${ctx.diagnostic})` : ""}.`
    };
  }
  return {
    scope: ctx.scopeKey,
    includeGlobal: scopeStr === "all",
    source: { client: ctx.client, conversationId: cid }
  };
}
function executeToolResult(name, rawArgs = {}, opts = {}) {
  const dataDir = opts.dataDir ?? "";
  const boardsHome = opts.boardsHome ?? "";
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  switch (name) {
    case "board_read": {
      const resolved = resolveBoardToolScope({
        rawScope: asString(args.scope),
        conversationId: asString(args.conversationId),
        dataDir,
        defaultScope: "all"
      });
      if (resolved.error) return { text: resolved.error, isError: true };
      const keys = Array.isArray(args.keys) ? args.keys.map(asString).filter(Boolean) : typeof args.keys === "string" && args.keys.trim() ? args.keys.split(",").map((s) => s.trim()).filter(Boolean) : void 0;
      return boardReadResult({
        scope: resolved.scope,
        includeGlobal: resolved.includeGlobal,
        keys,
        query: asString(args.query),
        offset: asOptionalNumber(args.offset),
        maxChars: asOptionalNumber(args.maxChars),
        boardsHome
      });
    }
    case "board_post": {
      const resolved = resolveBoardToolScope({
        rawScope: asString(args.scope),
        conversationId: asString(args.conversationId),
        dataDir,
        defaultScope: "project"
      });
      if (resolved.error) return { text: resolved.error, isError: true };
      const step = asOptionalNumber(args.step);
      const source = resolved.source ? { ...resolved.source, ...step !== void 0 && step >= 0 ? { step: Math.floor(step) } : {} } : void 0;
      return boardPostResult({
        scope: resolved.scope,
        key: asString(args.key),
        title: asString(args.title),
        body: asString(args.body),
        delete: Boolean(args.delete),
        expectedRevision: asString(args.expectedRevision),
        source,
        boardsHome
      });
    }
    case "search_sessions":
      return searchSessionsResult({
        dataDir,
        query: asString(args.query),
        mode: asString(args.mode) || "text",
        scope: asString(args.scope) || "all",
        regex: Boolean(args.regex),
        conversationId: asString(args.conversationId),
        scopeKey: asString(args.scopeKey),
        allScopes: Boolean(args.allScopes),
        sessionId: asString(args.sessionId),
        workspace: asString(args.workspace),
        includeChildren: Boolean(args.includeChildren),
        excludeSessionId: asString(args.excludeSessionId),
        sinceDays: Number(args.sinceDays) || 0,
        maxSessions: asOptionalNumber(args.maxSessions),
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
    default:
      return { text: `Error: Unknown tool: ${name}`, isError: true };
  }
}

// src/mcp-server.ts
var SERVER_INFO = {
  name: "agy-memory",
  version: "0.4.1"
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
          serverInfo: SERVER_INFO,
          instructions: "Project Blackboard and Verbatim Session Archive for Google Antigravity. Read/update active project decisions and handoffs with board_read and board_post (pass conversationId from [agy-memory] startup header; pass expectedRevision to update or delete). List or search past sessions/edits/errors with search_sessions (omit query to list; use mode='error_history' for failures) and inspect one session with read_session."
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
  const sendResponse = (resp) => {
    if (!resp) return;
    const payload = JSON.stringify(resp);
    if (framingMode === "lsp") {
      const byteLen = Buffer.byteLength(payload, "utf8");
      process.stdout.write(`Content-Length: ${byteLen}\r
\r
${payload}`);
    } else {
      process.stdout.write(`${payload}
`);
    }
  };
  const dispatchRawJson = (rawText) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendResponse({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) sendResponse(handleJsonRpcMessage(item));
    } else {
      sendResponse(handleJsonRpcMessage(parsed));
    }
  };
  const processBuffer = () => {
    while (rawBuf.length > 0) {
      let lead = 0;
      while (lead < rawBuf.length && (rawBuf[lead] === 13 || rawBuf[lead] === 10)) {
        lead += 1;
      }
      if (lead > 0) rawBuf = rawBuf.subarray(lead);
      if (rawBuf.length === 0) return;
      const firstByte = rawBuf[0];
      const looksLikeJson = firstByte === 123 || firstByte === 91;
      if (!looksLikeJson) {
        const sep = findHeaderSeparator(rawBuf);
        if (!sep) return;
        const headerBlock = rawBuf.subarray(0, sep.idx).toString("ascii");
        const lenMatch = /content-length:\s*(\d+)/i.exec(headerBlock);
        if (lenMatch) {
          framingMode = "lsp";
          const bodyLen = Number.parseInt(lenMatch[1], 10);
          const bodyStart = sep.idx + sep.sepLen;
          if (rawBuf.length < bodyStart + bodyLen) return;
          const bodyStr = rawBuf.subarray(bodyStart, bodyStart + bodyLen).toString("utf8");
          rawBuf = rawBuf.subarray(bodyStart + bodyLen);
          dispatchRawJson(bodyStr);
          continue;
        }
      }
      const nlIdx = rawBuf.indexOf(10);
      if (nlIdx === -1) return;
      if (!framingMode) framingMode = "jsonl";
      const lineStr = rawBuf.subarray(0, nlIdx).toString("utf8");
      rawBuf = rawBuf.subarray(nlIdx + 1);
      dispatchRawJson(lineStr);
    }
  };
  process.stdin.on("data", (chunk) => {
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
var BOOLEAN_CLI_FLAGS = /* @__PURE__ */ new Set([
  "all-scopes",
  "regex",
  "include-children",
  "include-tools",
  "include-thinking",
  "delete",
  "dry-run"
]);
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
        if (!BOOLEAN_CLI_FLAGS.has(key) && next !== void 0 && !next.startsWith("--")) {
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
function parseBoolFlag(flags, key) {
  const v = flags[key];
  if (v === void 0 || v === false) return { value: false };
  if (v === true) return { value: true };
  const low = String(v).trim().toLowerCase();
  if (low === "true" || low === "1") return { value: true };
  if (low === "false" || low === "0") return { value: false };
  return { value: false, error: `Error: Invalid boolean value "${v}" for --${key}. Use true or false.` };
}
function runCliMode(argv) {
  const { positional, flags } = parseCliArgs(argv);
  const sub = (positional[0] || "help").toLowerCase();
  const execOpts = {
    ...flagString(flags, "data-dir") ? { dataDir: flagString(flags, "data-dir") } : {},
    ...flagString(flags, "boards-home") ? { boardsHome: flagString(flags, "boards-home") } : {}
  };
  const failBool = (res) => {
    if (!res.error) return false;
    process.stderr.write(`${res.error}
`);
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
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      execOpts
    );
    process.stdout.write(`${text}
`);
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
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      execOpts
    );
    process.stdout.write(`${text}
`);
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
        maxChars: parseOptionalInt(flags["max-chars"])
      },
      execOpts
    );
    process.stdout.write(`${text}
`);
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
        delete: deleteFlag.value
      },
      execOpts
    );
    process.stdout.write(`${text}
`);
    if (isError) process.exitCode = 1;
    return;
  }
  if (sub === "migrate-notes") {
    const rawTarget = flagString(flags, "scope") || "global";
    const parsedTarget = parseExplicitScopeKey(rawTarget);
    if (!parsedTarget) {
      process.stderr.write(`Error: Invalid target --scope "${rawTarget}". Use "global", "project/<id>", "cli_repo/<gitDir>", or "cli_workspace/<dir>".
`);
      process.exitCode = 1;
      return;
    }
    const sourceDataDir = flagString(flags, "data-dir") || resolveDataDir();
    const res = migrateLegacyNotes({
      sourceDataDir,
      targetScope: parsedTarget,
      boardsHome: execOpts.boardsHome
    });
    process.stdout.write(
      `Migrated legacy notes from ${sourceDataDir}: imported=${res.imported}, skipped=${res.skipped}
${res.details.join("\n")}
`
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
      "  node dist/mcp-server.mjs --cli migrate-notes --scope global|project/<id> [--data-dir <dir>]"
    ].join("\n") + "\n"
  );
}
var cliFlagIdx = process.argv.indexOf("--cli");
if (cliFlagIdx >= 0) {
  runCliMode(process.argv.slice(cliFlagIdx + 1));
} else {
  runMcpStdioServer();
}
