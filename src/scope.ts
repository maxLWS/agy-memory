import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { ClientDataRoot, ClientKind, ScopeKey } from "./types.js";

const DEFAULT_PROJECT_SENTINELS = new Set(["default-cli-project"]);
const CONVERSATION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const PROJECT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/;
const MAX_TRAJECTORY_BLOB_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 1000;

export const SQLITE_CANDIDATES =
  process.platform === "win32"
    ? ["sqlite3", "sqlite3.exe"]
    : ["sqlite3", "/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"];

export const PYTHON_INVOCATIONS: ReadonlyArray<{ bin: string; prefixArgs: string[] }> =
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

interface NodeSqliteStatement {
  all: () => Array<Record<string, unknown>>;
  get?: (...args: unknown[]) => Record<string, unknown> | undefined;
}

interface NodeSqliteDatabase {
  exec?: (sql: string) => void;
  prepare: (sql: string) => NodeSqliteStatement;
  close: () => void;
}

type NodeSqliteCtor = new (
  location: string,
  options?: { readOnly?: boolean; open?: boolean; timeout?: number },
) => NodeSqliteDatabase;

let cachedNodeSqliteCtor: NodeSqliteCtor | null | undefined;

export function getNodeSqliteCtor(): NodeSqliteCtor | null {
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

export function getBusyTimeoutMs(): number {
  const raw = Number(process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 50 && raw <= 30_000) {
    return Math.floor(raw);
  }
  return DEFAULT_BUSY_TIMEOUT_MS;
}

export function getGeminiHome(): string {
  const envHome = (process.env.GEMINI_HOME || "").trim();
  if (envHome) return path.resolve(envHome);
  return path.join(os.homedir(), ".gemini");
}

export function resolveBoardsHome(overrideHome = ""): string {
  if (overrideHome && overrideHome.trim()) return path.resolve(overrideHome.trim());
  const envHome = (process.env.AGY_MEMORY_HOME || "").trim();
  if (envHome) return path.resolve(envHome);
  return path.join(getGeminiHome(), "agy-memory");
}

export function classifyClientDir(dirPath: string): ClientKind {
  const base = path.basename(path.resolve(dirPath)).toLowerCase();
  if (base === "antigravity") return "app";
  if (base === "antigravity-cli") return "cli";
  if (base === "antigravity-ide") return "ide";
  return "custom";
}

export function discoverClientDataDirs(overrideDir = ""): ClientDataRoot[] {
  const explicit = (overrideDir || "").trim() || (process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "").trim();
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? path.resolve(explicit) : path.join(getGeminiHome(), explicit);
    return [{ client: classifyClientDir(resolved), dataDir: resolved }];
  }

  const geminiHome = getGeminiHome();
  const candidates: ClientDataRoot[] = [
    { client: "app", dataDir: path.join(geminiHome, "antigravity") },
    { client: "cli", dataDir: path.join(geminiHome, "antigravity-cli") },
    { client: "ide", dataDir: path.join(geminiHome, "antigravity-ide") },
  ];
  const existing = candidates.filter((c) => fs.existsSync(c.dataDir));
  if (existing.length > 0) return existing;
  return [candidates[1]!];
}

export function inferDataDirFromTranscriptPath(transcriptPath: string): string {
  const raw = String(transcriptPath || "").trim();
  if (!raw) return "";
  const normalized = path.resolve(raw).replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/brain/");
  if (idx <= 0) return "";
  return normalized.slice(0, idx);
}

export function normalizeCanonicalPath(rawPath: string): string {
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
      candidate = fs.realpathSync(candidate);
    }
  } catch {
  }
  let slash = candidate.replace(/\\/g, "/");
  if (/^[A-Z]:\//.test(slash)) {
    slash = `${slash[0]!.toLowerCase()}${slash.slice(1)}`;
  }
  while (slash.length > 1 && slash.endsWith("/") && !/^[a-zA-Z]:\/$/.test(slash)) {
    slash = slash.slice(0, -1);
  }
  return slash;
}

export function isTempDirectory(rawPath: string): boolean {
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

export function resolveGitCommonDir(startDir: string): string {
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

export function isValidConversationId(id: string): boolean {
  return CONVERSATION_ID_RE.test(String(id || "").trim());
}

export function isValidProjectId(id: string): boolean {
  const trimmed = String(id || "").trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (trimmed.includes("..") || trimmed.includes("\\")) return false;
  return PROJECT_ID_RE.test(trimmed);
}

export interface TrajectoryBlobMeta {
  projectId: string | null;
  workspaces: string[];
}

export function decodeTrajectoryMetadata(blob: Uint8Array): TrajectoryBlobMeta | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength > MAX_TRAJECTORY_BLOB_BYTES) {
    return null;
  }
  let pos = 0;
  const len = blob.byteLength;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let foundProjectId: string | null = null;
  const workspaces: string[] = [];

  const readVarint = (): bigint | null => {
    let value = 0n;
    let shift = 0n;
    for (let count = 0; count < 10; count += 1) {
      if (pos >= len) return null;
      const b = blob[pos]!;
      pos += 1;
      if (count === 9 && b > 1) return null;
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value;
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
        let decoded: string;
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

export function decodeTrajectoryProjectId(blob: Uint8Array): string | null {
  return decodeTrajectoryMetadata(blob)?.projectId ?? null;
}

export function readConversationDbMeta(
  dataDir: string,
  conversationId: string,
  timeoutMs = getBusyTimeoutMs(),
): { projectId: string | null; workspaces: string[]; error?: string } {
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
    let db: NodeSqliteDatabase | null = null;
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
          "SELECT hex(data) AS hexdata FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1;",
        ],
        {
          encoding: "utf8",
          timeout: Math.max(2000, timeoutMs + 1500),
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const trimmed = String(stdout || "").trim();
      if (!trimmed) return { projectId: null, workspaces: [] };
      const rows = JSON.parse(trimmed) as Array<{ hexdata?: unknown }>;
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(stdout) as { hex?: string };
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

export function readProjectIdFromConversationDb(
  dataDir: string,
  conversationId: string,
  timeoutMs = getBusyTimeoutMs(),
): { projectId: string | null; error?: string } {
  const res = readConversationDbMeta(dataDir, conversationId, timeoutMs);
  return { projectId: res.projectId, ...(res.error ? { error: res.error } : {}) };
}

export function pickPrimaryWorkspaceRoot(workspaces: string[]): string {
  const candidates: string[] = [];
  for (const w of workspaces) {
    const norm = normalizeCanonicalPath(w);
    if (norm && !candidates.includes(norm)) candidates.push(norm);
  }
  if (candidates.length === 0) return "";
  const nonTemp = candidates.find((c) => !isTempDirectory(c));
  return nonTemp || candidates[0]!;
}

export function resolveScopeKey(input: {
  projectId?: string | null;
  workspaces?: string[];
}): ScopeKey {
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

export function formatScopeKey(scope: ScopeKey): string {
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

export function parseExplicitScopeKey(raw: string): ScopeKey | null {
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

export function scopeKeysEqual(a: ScopeKey, b: ScopeKey): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "project":
      return a.projectId === (b as Extract<ScopeKey, { kind: "project" }>).projectId;
    case "cli_repo":
      return a.commonGitDir === (b as Extract<ScopeKey, { kind: "cli_repo" }>).commonGitDir;
    case "cli_workspace":
      return a.root === (b as Extract<ScopeKey, { kind: "cli_workspace" }>).root;
    case "global":
      return true;
    case "unresolved":
      return false;
  }
}

export function scopeKeyToBoardDir(scope: ScopeKey, boardsHome = resolveBoardsHome()): string {
  if (scope.kind === "unresolved") {
    throw new Error("Cannot map unresolved scope to a board directory.");
  }
  if (scope.kind === "global") {
    return path.join(path.resolve(boardsHome), "boards", "global");
  }
  const canonical = formatScopeKey(scope);
  const hash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 20);
  const label =
    scope.kind === "project"
      ? scope.projectId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24)
      : path.posix.basename(scope.kind === "cli_repo" ? path.posix.dirname(scope.commonGitDir) : scope.root).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24) || "ws";
  return path.join(path.resolve(boardsHome), "boards", `${scope.kind}_${label}_${hash}`);
}
