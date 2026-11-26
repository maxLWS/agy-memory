import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  formatScopeKey,
  resolveBoardsHome,
  scopeKeyToBoardDir,
} from "./scope.js";
import type { BoardEntry, BoardSourceRef, ClientKind, ScopeKey, ToolResult } from "./types.js";

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CORRUPT_LOCK_GRACE_MS = 2_000;
const REAP_GUARD_STALE_MS = 5_000;
const LOCK_WAIT_TIMEOUT_MS = 2_000;
const SLEEP_ARR = new Int32Array(new SharedArrayBuffer(4));

export function isValidBoardKey(rawKey: string): boolean {
  return KEY_RE.test(String(rawKey || "").trim());
}

export function normalizeBoardKey(rawKey: string): string {
  return String(rawKey || "").trim().toLowerCase();
}

function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(SLEEP_ARR, 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

function isLockStale(lockPath: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return false;
  }
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return !isProcessAlive(parsed.pid);
    }
  } catch {
    // Fall through to corrupt/empty grace check
  }
  return Date.now() - st.mtimeMs > CORRUPT_LOCK_GRACE_MS;
}

function tryReapDeadLock(entriesDir: string, key: string, lockPath: string): boolean {
  const reapDir = path.join(entriesDir, `.${key}.reap`);
  try {
    fs.mkdirSync(reapDir, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") {
      try {
        const st = fs.statSync(reapDir);
        if (Date.now() - st.mtimeMs > REAP_GUARD_STALE_MS) {
          fs.rmdirSync(reapDir);
        }
      } catch {
        // Guard already released
      }
    }
    return false;
  }

  try {
    if (isLockStale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    try {
      fs.rmdirSync(reapDir);
    } catch {
      // Ignore cleanup race
    }
  }
}

function withPerKeyLock<T>(entriesDir: string, key: string, fn: () => T): T {
  fs.mkdirSync(entriesDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(entriesDir, `.${key}.lock`);
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const claimPath = path.join(entriesDir, `.${key}.claim.${nonce}`);
  const lockPayload = JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() });

  const claimFd = fs.openSync(claimPath, "wx", 0o600);
  try {
    fs.writeFileSync(claimFd, lockPayload, "utf8");
    fs.fsyncSync(claimFd);
  } finally {
    fs.closeSync(claimFd);
  }

  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let acquired = false;

  try {
    while (Date.now() < deadline) {
      try {
        fs.linkSync(claimPath, lockPath);
        acquired = true;
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") {
          if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP") {
            try {
              const fd = fs.openSync(lockPath, "wx", 0o600);
              try {
                fs.writeFileSync(fd, lockPayload, "utf8");
              } finally {
                fs.closeSync(fd);
              }
              acquired = true;
              break;
            } catch (wxErr) {
              if ((wxErr as NodeJS.ErrnoException)?.code !== "EEXIST") throw wxErr;
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
      fs.unlinkSync(claimPath);
    } catch {
      // Ignore claim cleanup
    }
  }

  if (!acquired) {
    throw new Error(`Timed out acquiring board lock for key "${key}" (${lockPath}).`);
  }

  try {
    return fn();
  } finally {
    try {
      const cur = fs.readFileSync(lockPath, "utf8");
      if (cur.includes(nonce)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore release race
    }
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}

function yamlScalar(v: string): string {
  return JSON.stringify(String(v ?? ""));
}

function parseYamlScalar(raw: string): string {
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

export function computeBoardRevision(entry: {
  key: string;
  title: string;
  body: string;
  updatedAt: number;
  source?: BoardSourceRef;
}): string {
  const canonical = JSON.stringify({
    key: entry.key,
    title: entry.title,
    body: entry.body,
    updatedAt: entry.updatedAt,
    source: entry.source || null,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12);
}

export function serializeBoardEntry(entry: {
  key: string;
  title: string;
  body: string;
  updatedAt: number;
  source?: BoardSourceRef;
}): string {
  const lines = [
    "---",
    "schema: 1",
    `key: ${yamlScalar(entry.key)}`,
    `title: ${yamlScalar(entry.title)}`,
    `updatedAt: ${yamlScalar(new Date(entry.updatedAt).toISOString())}`,
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

export function parseBoardEntryFile(filePath: string, scope: ScopeKey): BoardEntry | null {
  let raw: string;
  let st: fs.Stats;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    st = fs.statSync(filePath);
  } catch {
    return null;
  }

  const slug = path.basename(filePath, ".md");
  const normalized = raw.replace(/\r\n/g, "\n");
  let key = slug;
  let title = "";
  let updatedAt = Math.floor(st.mtimeMs || Date.now());
  let sourceClient: ClientKind = "cli";
  let sourceSession = "";
  let sourceStep: number | undefined;
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
          const c = parseYamlScalar(v) as ClientKind;
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

  const source: BoardSourceRef | undefined = sourceSession
    ? { client: sourceClient, conversationId: sourceSession, ...(sourceStep !== undefined ? { step: sourceStep } : {}) }
    : undefined;

  const revision = computeBoardRevision({ key, title, body, updatedAt, source });
  return {
    key,
    title,
    body,
    revision,
    updatedAt,
    scope,
    source,
    filePath,
  };
}

export function getBoardEntriesDir(scope: ScopeKey, boardsHome = resolveBoardsHome()): string {
  return path.join(scopeKeyToBoardDir(scope, boardsHome), "entries");
}

export function loadBoardEntries(scope: ScopeKey, boardsHome = resolveBoardsHome()): BoardEntry[] {
  if (scope.kind === "unresolved") return [];
  const entriesDir = getBoardEntriesDir(scope, boardsHome);
  let files: string[];
  try {
    files = fs
      .readdirSync(entriesDir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .sort();
  } catch {
    return [];
  }

  const out: BoardEntry[] = [];
  for (const fn of files) {
    const parsed = parseBoardEntryFile(path.join(entriesDir, fn), scope);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
  return out;
}

export function formatBoardEntryBlock(entry: BoardEntry, includeScopeBadge = false): string {
  const scopeTag = includeScopeBadge && entry.scope.kind === "global" ? " [global]" : "";
  const titlePart = entry.title && entry.title !== entry.key ? ` — ${entry.title}` : "";
  const srcPart = entry.source?.conversationId
    ? ` · from ${entry.source.conversationId.slice(0, 8)}${entry.source.step !== undefined ? `#${entry.source.step}` : ""}`
    : "";
  const iso = new Date(entry.updatedAt).toISOString().slice(0, 16).replace("T", " ");
  return `## ${entry.key}${scopeTag}${titlePart}\nMeta: rev=${entry.revision} · updated=${iso}Z${srcPart}\nPath: ${entry.filePath}\n${entry.body}`;
}

export interface BoardReadOptions {
  scope: ScopeKey;
  includeGlobal?: boolean;
  keys?: string[];
  query?: string;
  offset?: number;
  maxChars?: number;
  boardsHome?: string;
}

export function boardReadResult(opts: BoardReadOptions): ToolResult {
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const maxChars = Math.max(200, Math.min(8200, Math.floor(Number(opts.maxChars) || 8200)));
  const maxBytes = Math.min(8650, maxChars + 450);

  if (opts.scope.kind === "unresolved") {
    return {
      text: "Error: Project scope is unresolved. Pass conversationId (from [agy-memory] startup header) or scope=\"global\".",
      isError: true,
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
      isError: false,
    };
  }

  const startOffset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const slice = entries.slice(startOffset);
  if (slice.length === 0) {
    return {
      text: `No entries at offset=${startOffset} (${entries.length} total entries in ${scopeLabel}).`,
      isError: false,
    };
  }

  const header = `Project board (${scopeLabel}${opts.includeGlobal && opts.scope.kind !== "global" ? " + global" : ""}, ${entries.length} entry/entries):`;
  const blocks: string[] = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  let shownCount = 0;

  for (const entry of slice) {
    const block = `\n\n${formatBoardEntryBlock(entry, Boolean(opts.includeGlobal))}`;
    const bBytes = Buffer.byteLength(block, "utf8");
    const reserveFooter = 180;
    if (shownCount > 0 && (usedBytes + bBytes + reserveFooter > maxBytes || blocks.join("").length + block.length + reserveFooter > maxChars)) {
      break;
    }
    if (shownCount === 0 && usedBytes + bBytes > maxBytes) {
      blocks.push(
        `\n\n## ${entry.key} (exceeds inline budget: ${bBytes} B; read directly via read_file)\nMeta: rev=${entry.revision}\nPath: ${entry.filePath}`,
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
    blocks.push(`\n\n(${remaining} more entry/entries omitted at entry boundary; call board_read with offset=${startOffset + shownCount}.)`);
  }

  return { text: blocks.join(""), isError: false };
}

export interface BoardPostOptions {
  scope: ScopeKey;
  key: string;
  title?: string;
  body?: string;
  delete?: boolean;
  expectedRevision?: string;
  source?: BoardSourceRef;
  boardsHome?: string;
}

export function boardPostResult(opts: BoardPostOptions): ToolResult {
  if (opts.scope.kind === "unresolved") {
    return {
      text: "Error: Project scope is unresolved. Pass conversationId (from [agy-memory] startup header) or scope=\"global\" before mutating a board.",
      isError: true,
    };
  }

  const key = normalizeBoardKey(opts.key);
  if (!isValidBoardKey(key)) {
    return {
      text: `Error: Invalid board key "${opts.key}". Use 1..64 lowercase ASCII letters, digits, '.', '_' or '-' starting with a letter or digit (e.g. "release-command").`,
      isError: true,
    };
  }

  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const entriesDir = getBoardEntriesDir(opts.scope, boardsHome);
  const entryPath = path.join(entriesDir, `${key}.md`);
  const scopeLabel = formatScopeKey(opts.scope);
  const expectedRev = String(opts.expectedRevision || "").trim();

  try {
    return withPerKeyLock(entriesDir, key, () => {
      const existing = fs.existsSync(entryPath) ? parseBoardEntryFile(entryPath, opts.scope) : null;

      if (opts.delete) {
        if (!existing) {
          return {
            text: `Error: Board key "${key}" does not exist in ${scopeLabel}.`,
            isError: true,
          };
        }
        if (!expectedRev) {
          return {
            text: `Error: Deleting "${key}" requires expectedRevision="${existing.revision}" (call board_read first).`,
            isError: true,
          };
        }
        if (existing.revision !== expectedRev) {
          return {
            text: `Error: Revision conflict deleting "${key}": expected "${expectedRev}", current is "${existing.revision}". Call board_read before retrying.`,
            isError: true,
          };
        }
        fs.unlinkSync(entryPath);
        return {
          text: `Removed board key "${key}" from ${scopeLabel} (previous rev=${existing.revision}).`,
          isError: false,
        };
      }

      const body = String(opts.body ?? "").trim();
      if (!body) {
        return {
          text: `Error: body is required when creating or updating board key "${key}".`,
          isError: true,
        };
      }

      if (existing) {
        if (!expectedRev) {
          return {
            text: `Error: Board key "${key}" already exists in ${scopeLabel} (current rev=${existing.revision}). Pass expectedRevision="${existing.revision}" to replace it.`,
            isError: true,
          };
        }
        if (existing.revision !== expectedRev) {
          return {
            text: `Error: Revision conflict updating "${key}": expected "${expectedRev}", current is "${existing.revision}". Call board_read before retrying.`,
            isError: true,
          };
        }
      } else if (expectedRev) {
        return {
          text: `Error: Board key "${key}" does not exist in ${scopeLabel}, so expectedRevision="${expectedRev}" cannot match.`,
          isError: true,
        };
      }

      const title = String(opts.title ?? "").trim() || existing?.title || key;
      const updatedAt = Date.now();
      const serialized = serializeBoardEntry({
        key,
        title,
        body,
        updatedAt,
        source: opts.source,
      });
      writeFileAtomic(entryPath, serialized);
      const saved = parseBoardEntryFile(entryPath, opts.scope)!;
      const verb = existing ? "Updated" : "Created";
      return {
        text: `${verb} board key "${saved.key}" in ${scopeLabel}\nRevision: ${saved.revision}\nPath: ${saved.filePath}`,
        isError: false,
      };
    });
  } catch (err) {
    return {
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export interface MigrateLegacyNotesResult {
  imported: number;
  skipped: number;
  details: string[];
}

export function migrateLegacyNotes(opts: {
  sourceDataDir: string;
  targetScope: ScopeKey;
  boardsHome?: string;
  dryRun?: boolean;
}): MigrateLegacyNotesResult {
  const details: string[] = [];
  let imported = 0;
  let skipped = 0;

  if (opts.targetScope.kind === "unresolved") {
    throw new Error("targetScope must be resolved before migrating notes.");
  }

  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const resolvedSource = path.resolve(opts.sourceDataDir);
  const topicDirs = [
    path.join(resolvedSource, "plugin_data", "agy-memory", "memory", "topics"),
    path.join(resolvedSource, "memory", "topics"),
  ];
  const topicsDir = topicDirs.find((dir) => fs.existsSync(dir)) || "";
  const legacyJsonPaths = [
    path.join(resolvedSource, "plugin_data", "agy-memory", "notes.json"),
    path.join(resolvedSource, "notes.json"),
  ];
  const legacyJson = legacyJsonPaths.find((filePath) => fs.existsSync(filePath)) || "";

  const candidates: Array<{ key: string; title: string; body: string; sourceSession: string }> = [];

  if (topicsDir) {
    for (const fn of fs.readdirSync(topicsDir).filter((f) => f.endsWith(".md")).sort()) {
      const raw = fs.readFileSync(path.join(topicsDir, fn), "utf8").replace(/\r\n/g, "\n");
      const slug = normalizeBoardKey(path.basename(fn, ".md").replace(/[^a-zA-Z0-9._-]/g, "-")).slice(0, 64);
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
  } else if (legacyJson) {
    try {
      const arr = JSON.parse(fs.readFileSync(legacyJson, "utf8")) as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const rawId = String(item.id || item.topic || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
          const body = String(item.content || "").trim();
          if (isValidBoardKey(rawId) && body) {
            candidates.push({
              key: rawId,
              title: String(item.topic || rawId),
              body,
              sourceSession: String(item.sessionId || ""),
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
    const existingPath = path.join(existingDir, `${c.key}.md`);
    if (fs.existsSync(existingPath)) {
      skipped += 1;
      details.push(`${opts.dryRun ? "Would skip" : "Skipped"} existing key "${c.key}"`);
      continue;
    }
    if (opts.dryRun) {
      imported += 1;
      details.push(`Would import "${c.key}" -> ${formatScopeKey(opts.targetScope)}`);
      continue;
    }
    const res = boardPostResult({
      scope: opts.targetScope,
      key: c.key,
      title: c.title,
      body: c.body,
      boardsHome,
      source: c.sourceSession ? { client: "cli", conversationId: c.sourceSession } : undefined,
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
