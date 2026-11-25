import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  HarnessSource,
  ScanBudget,
  SearchableMessage,
  SearchableSessionDoc,
  SessionEntry,
  SessionPaths,
  TranscriptTurn,
} from "./types.js";

const HEAD_META_BYTES = 16 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_CACHE = 48;

interface IncrementalCacheEntry<T> {
  offset: number;
  eof: boolean;
  mtimeMs: number;
  size: number;
  state: T;
}

interface ExternalCatalogCache {
  sig: string;
  entries: SessionEntry[];
}

interface HeadMetaCacheEntry {
  sig: string;
  sessionId: string;
  cwd: string;
  startedMs: number;
  firstUser: string;
  isSidechain: boolean;
}

const extCatalogCache = new Map<string, ExternalCatalogCache>();
const extHeadMetaCache = new Map<string, HeadMetaCacheEntry>();
const extSearchCache = new Map<
  string,
  IncrementalCacheEntry<SearchableSessionDoc & { nextStep: number; lastUser: string }>
>();

export function clearAdapterCaches(): void {
  extCatalogCache.clear();
  extHeadMetaCache.clear();
  extSearchCache.clear();
}

function lruPut<K, V>(map: Map<K, V>, key: K, val: V, limit = MAX_CACHE): void {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export function createScanBudget(maxScanBytes = 32 * 1024 * 1024, maxScanMs = 2500): ScanBudget {
  return {
    maxScanBytes,
    maxScanMs,
    startedAtMs: Date.now(),
    bytesRead: 0,
    sessionsScanned: 0,
    incomplete: false,
    reason: "",
  };
}

export function checkScanBudget(budget: ScanBudget | undefined): boolean {
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

/**
 * Incrementally streams complete UTF-8 lines starting from `startOffset`, updating `budget.bytesRead`.
 * - Linear O(N) newline scanning even for multi-MB single lines (only scans newly read bytes).
 * - Leaves unterminated/partial trailing JSON lines unconsumed so live appends resume cleanly.
 * - Propagates I/O errors into `budget.incomplete = true` (never claims a complete scan on read error).
 */
export function streamJsonlFromOffset(
  filePath: string,
  startOffset: number,
  onLine: (line: string) => void,
  budget?: ScanBudget,
): { newOffset: number; eof: boolean; size: number; mtimeMs: number; ioError: boolean } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const size = st.size;
    const mtimeMs = st.mtimeMs;
    let pos = Math.max(0, startOffset);
    if (pos >= size) {
      return { newOffset: size, eof: true, size, mtimeMs, ioError: false };
    }

    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carryParts: Buffer[] = [];
    let carryLen = 0;
    let consumedBytes = pos;

    while (pos < size) {
      if (budget && !checkScanBudget(budget)) {
        return { newOffset: consumedBytes, eof: false, size, mtimeMs, ioError: false };
      }
      const remainingBudget = budget ? Math.max(1, budget.maxScanBytes - budget.bytesRead) : CHUNK_BYTES;
      const toRead = Math.min(CHUNK_BYTES, size - pos, remainingBudget);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      pos += n;
      if (budget) budget.bytesRead += n;

      const slice = buf.subarray(0, n);
      let segStart = 0;
      for (let i = 0; i < n; i += 1) {
        if (slice[i] === 0x0a) {
          let lineBuf: Buffer;
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
        // Only consume a trailing line without '\n' if it is already complete valid JSON;
        // otherwise keep consumedBytes at the last '\n' so a live half-written line is retried next call.
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
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function readHeadUtf8(filePath: string, maxBytes = HEAD_META_BYTES): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return "";
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function emptyPaths(transcriptPath: string): SessionPaths {
  const dir = path.dirname(transcriptPath);
  return {
    brainDir: dir,
    systemDir: dir,
    transcriptPath,
    transcriptFullPath: "",
    swarmDir: "",
    swarmMembersPath: "",
    swarmBoardPath: "",
    swarmPlanPath: "",
    subagentsDir: "",
  };
}

function formatDateShort(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function parseTs(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : raw;
  }
  if (typeof raw !== "string" || !raw.trim()) return 0;
  const ms = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? 0 : ms;
}

export function resolveCodexDir(): string {
  return (process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
}

export function resolveClaudeDir(): string {
  return (process.env.CLAUDE_CONFIG_DIR || "").trim() || path.join(os.homedir(), ".claude");
}

function walkJsonlFiles(rootDir: string, maxDepth = 4, skipDirNames: Set<string> = new Set()): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      if (d.name.startsWith(".")) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (skipDirNames.has(d.name)) continue;
        walk(full, depth + 1);
      } else if (d.isFile() && d.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(rootDir, 0);
  out.sort();
  return out;
}

function normalizeTextBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const obj = b as Record<string, unknown>;
    if (typeof obj.text === "string" && obj.text.trim()) {
      parts.push(obj.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function isCodexSystemBoilerplate(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("<permissions instructions>") || t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions for ") || t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}

export function resolveToolPath(rawPath: string, primaryWorkspace: string): {
  rawPath: string;
  resolvedPath: string;
  basename: string;
} {
  const cleaned = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return { rawPath: "", resolvedPath: "", basename: "" };
  const isWin = /^[a-zA-Z]:[\\/]/.test(cleaned) || /^[a-zA-Z]:[\\/]/.test(primaryWorkspace);
  const pathImpl = isWin ? path.win32 : path.posix;
  let resolved = cleaned;
  if (!pathImpl.isAbsolute(cleaned) && primaryWorkspace) {
    resolved = pathImpl.resolve(primaryWorkspace, cleaned);
  } else {
    resolved = pathImpl.normalize(cleaned);
  }
  const normalized = resolved.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  return { rawPath: cleaned, resolvedPath: normalized, basename };
}

function statAllFiles(files: string[]): Array<{ filePath: string; st: fs.Stats }> {
  const out: Array<{ filePath: string; st: fs.Stats }> = [];
  for (const filePath of files) {
    try {
      out.push({ filePath, st: fs.statSync(filePath) });
    } catch {
      // Ignore unreadable file
    }
  }
  return out;
}

function computeFullCatalogSig(
  indexMtime: number,
  statList: Array<{ filePath: string; st: fs.Stats }>,
): string {
  // Hash every path + mtime + size so a change to any session invalidates the catalog cache
  return `${statList.length}|${indexMtime}|${statList
    .map((x) => `${x.filePath}:${Math.round(x.st.mtimeMs)}:${x.st.size}`)
    .join("|")}`;
}

export function loadCodexCatalog(codexDir = resolveCodexDir()): SessionEntry[] {
  if (!fs.existsSync(codexDir)) return [];
  const sessionsDir = path.join(codexDir, "sessions");
  const archivedDir = path.join(codexDir, "archived_sessions");
  const indexPath = path.join(codexDir, "session_index.jsonl");
  const files = [...walkJsonlFiles(sessionsDir, 4), ...walkJsonlFiles(archivedDir, 4)];
  const statList = statAllFiles(files);
  const indexMtime = fs.existsSync(indexPath) ? Math.round(fs.statSync(indexPath).mtimeMs) : 0;
  const sig = computeFullCatalogSig(indexMtime, statList);

  const cacheKey = `codex:${codexDir}`;
  const cached = extCatalogCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.entries;

  const titles = new Map<string, { title: string; updatedMs: number }>();
  if (fs.existsSync(indexPath)) {
    try {
      for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
        if (row.id) {
          titles.set(row.id, {
            title: String(row.thread_name || "").trim(),
            updatedMs: parseTs(row.updated_at),
          });
        }
      }
    } catch {
      // Optional index
    }
  }

  statList.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  const entries: SessionEntry[] = [];
  for (const { filePath, st } of statList) {
    const fname = path.basename(filePath, ".jsonl");
    const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fname);
    const defaultId = idMatch ? idMatch[1]! : fname;
    const headSig = `${Math.round(st.mtimeMs)}:${st.size}`;

    let meta = extHeadMetaCache.get(filePath);
    if (!meta || meta.sig !== headSig) {
      let sessionId = defaultId;
      let cwd = "";
      let startedMs = 0;
      let firstUser = "";
      const head = readHeadUtf8(filePath, HEAD_META_BYTES);
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
          const p = obj.payload as Record<string, unknown>;
          if (p.id || p.session_id) sessionId = String(p.id || p.session_id).trim();
          if (!cwd && typeof p.cwd === "string") cwd = p.cwd.trim();
          if (!startedMs) startedMs = parseTs(p.timestamp || obj.timestamp);
        } else if (!firstUser && obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
          const p = obj.payload as Record<string, unknown>;
          if (p.type === "message" && p.role === "user") {
            const txt = normalizeTextBlocks(p.content);
            if (!isCodexSystemBoilerplate(txt)) {
              firstUser = txt.replace(/\s+/g, " ").slice(0, 120);
            }
          }
        }
        if (cwd && firstUser) break;
      }
      meta = { sig: headSig, sessionId, cwd, startedMs, firstUser, isSidechain: false };
      extHeadMetaCache.set(filePath, meta);
    }

    const finalIdx = titles.get(meta.sessionId) || titles.get(defaultId);
    const updatedMs = Math.max(st.mtimeMs, finalIdx?.updatedMs || 0, meta.startedMs);
    const title = finalIdx?.title || meta.firstUser.slice(0, 72) || "(codex session)";
    const approxSteps = Math.max(1, Math.round(st.size / 1800));
    entries.push({
      source: "codex",
      canonicalId: `codex:${meta.sessionId}`,
      sessionId: meta.sessionId,
      shortId: meta.sessionId.slice(0, 8),
      title,
      preview: meta.firstUser || title,
      stepCount: approxSteps,
      updatedMs,
      workspaces: meta.cwd ? [meta.cwd] : [],
      status: "IDLE",
      isChild: false,
      parentConversationId: "",
      hasTranscript: true,
      hasSwarm: false,
      paths: emptyPaths(filePath),
    });
  }

  entries.sort((a, b) => b.updatedMs - a.updatedMs);
  extCatalogCache.set(cacheKey, { sig, entries });
  return entries;
}

export function loadClaudeCatalog(claudeDir = resolveClaudeDir()): SessionEntry[] {
  if (!fs.existsSync(claudeDir)) return [];
  const projectsDir = path.join(claudeDir, "projects");
  const transcriptsDir = path.join(claudeDir, "transcripts");
  const historyPath = path.join(claudeDir, "history.jsonl");
  // Skip subagents directories to avoid sidechain collisions with parent session IDs
  const files = [
    ...walkJsonlFiles(projectsDir, 2, new Set(["subagents"])),
    ...walkJsonlFiles(transcriptsDir, 2, new Set(["subagents"])),
  ];
  const statList = statAllFiles(files);
  const historyMtime = fs.existsSync(historyPath) ? Math.round(fs.statSync(historyPath).mtimeMs) : 0;
  const sig = computeFullCatalogSig(historyMtime, statList);

  const cacheKey = `claude:${claudeDir}`;
  const cached = extCatalogCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.entries;

  const historyMeta = new Map<string, { project: string; title: string; updatedMs: number }>();
  if (fs.existsSync(historyPath)) {
    try {
      for (const line of fs.readFileSync(historyPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as { sessionId?: string; project?: string; display?: string; timestamp?: unknown };
        if (row.sessionId) {
          const prev = historyMeta.get(row.sessionId);
          const ts = parseTs(row.timestamp);
          historyMeta.set(row.sessionId, {
            project: String(row.project || prev?.project || "").trim(),
            title: String(row.display || prev?.title || "").replace(/\s+/g, " ").trim().slice(0, 80),
            updatedMs: Math.max(ts, prev?.updatedMs || 0),
          });
        }
      }
    } catch {
      // Optional history
    }
  }

  const seenIds = new Set<string>();
  const entries: SessionEntry[] = [];
  for (const { filePath, st } of statList) {
    const baseId = path.basename(filePath, ".jsonl");
    const headSig = `${Math.round(st.mtimeMs)}:${st.size}`;
    let meta = extHeadMetaCache.get(filePath);
    if (!meta || meta.sig !== headSig) {
      let embeddedId = "";
      let cwd = "";
      let firstUser = "";
      let startedMs = 0;
      let isSidechain = baseId.startsWith("agent-");
      const head = readHeadUtf8(filePath, HEAD_META_BYTES);
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.isSidechain === true) isSidechain = true;
        if (!embeddedId && typeof obj.sessionId === "string" && obj.sessionId.trim()) {
          embeddedId = obj.sessionId.trim();
        }
        if (!cwd && typeof obj.cwd === "string" && obj.cwd.trim()) cwd = obj.cwd.trim();
        if (!startedMs) startedMs = parseTs(obj.timestamp);
        if (!firstUser && obj.type === "user") {
          const msg = obj.message as Record<string, unknown> | undefined;
          const txt = msg ? normalizeTextBlocks(msg.content) : normalizeTextBlocks(obj.content);
          if (txt) firstUser = txt.replace(/\s+/g, " ").slice(0, 120);
        }
      }
      // Sidechain files keep their own unique filename stem so they never collide with the parent session ID
      const sessionId = isSidechain ? baseId : embeddedId || baseId;
      meta = { sig: headSig, sessionId, cwd, startedMs, firstUser, isSidechain };
      extHeadMetaCache.set(filePath, meta);
    }

    let finalSessionId = meta.sessionId;
    let isChild = meta.isSidechain;
    let parentId = "";
    if (seenIds.has(finalSessionId)) {
      parentId = finalSessionId;
      finalSessionId = baseId !== finalSessionId ? baseId : `${finalSessionId}-${entries.length + 1}`;
      isChild = true;
    }
    seenIds.add(finalSessionId);

    const h = historyMeta.get(finalSessionId);
    const cwd = meta.cwd || h?.project || "";
    const title = h?.title || meta.firstUser.slice(0, 72) || "(claude session)";
    const updatedMs = Math.max(st.mtimeMs, h?.updatedMs || 0, meta.startedMs);
    const approxSteps = Math.max(1, Math.round(st.size / 1200));
    const shortId = finalSessionId.startsWith("ses_") ? finalSessionId.slice(0, 12) : finalSessionId.slice(0, 8);
    entries.push({
      source: "claude",
      canonicalId: `claude:${finalSessionId}`,
      sessionId: finalSessionId,
      shortId,
      title,
      preview: meta.firstUser || title,
      stepCount: approxSteps,
      updatedMs,
      workspaces: cwd ? [cwd] : [],
      status: "IDLE",
      isChild,
      parentConversationId: parentId,
      hasTranscript: true,
      hasSwarm: false,
      paths: emptyPaths(filePath),
    });
  }

  entries.sort((a, b) => b.updatedMs - a.updatedMs);
  extCatalogCache.set(cacheKey, { sig, entries });
  return entries;
}

function handleExternalLineForSearch(
  source: HarnessSource,
  line: string,
  state: SearchableSessionDoc & { nextStep: number; lastUser: string },
): void {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const idx = state.nextStep;
  state.nextStep += 1;
  const date = formatDateShort(parseTs(obj.timestamp));

  if (source === "codex") {
    if (obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
      const p = obj.payload as Record<string, unknown>;
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const text = normalizeTextBlocks(p.content);
        if (!text || (p.role === "user" && isCodexSystemBoilerplate(text))) return;
        const msg: SearchableMessage = {
          stepIndex: idx,
          role: p.role,
          date,
          text,
          lowText: text.toLowerCase(),
        };
        state.messages.push(msg);
      }
    } else if (obj.type === "event_msg" && obj.payload && typeof obj.payload === "object") {
      const p = obj.payload as Record<string, unknown>;
      if (p.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
        const text = p.message.trim();
        if (!isCodexSystemBoilerplate(text)) {
          state.messages.push({ stepIndex: idx, role: "user", date, text, lowText: text.toLowerCase() });
        }
      } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
        const text = p.message.trim();
        state.messages.push({ stepIndex: idx, role: "assistant", date, text, lowText: text.toLowerCase() });
      }
    }
    return;
  }

  if (source === "claude") {
    if (obj.type === "user" || obj.type === "assistant") {
      const msgObj = obj.message as Record<string, unknown> | undefined;
      const text = msgObj ? normalizeTextBlocks(msgObj.content) : normalizeTextBlocks(obj.content);
      if (!text) return;
      state.messages.push({
        stepIndex: idx,
        role: obj.type,
        date,
        text,
        lowText: text.toLowerCase(),
      });
    }
  }
}

export function getExternalSearchableDoc(entry: SessionEntry, budget?: ScanBudget): SearchableSessionDoc {
  const filePath = entry.paths.transcriptPath;
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch (err) {
    if (budget) {
      budget.incomplete = true;
      budget.reason = `transcript stat error (${err instanceof Error ? err.message : "stat failed"})`;
    }
    return { messages: [], artifacts: [], board: [], latestTranscriptMtimeMs: 0, inFlightUserStepIndex: -1 };
  }

  const cached = extSearchCache.get(filePath);
  let state: SearchableSessionDoc & { nextStep: number; lastUser: string };
  let startOffset = 0;

  const canReuseExact = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
  const canResumeAppend = cached && cached.eof && cached.size < st.size;

  if (canReuseExact && cached.eof) {
    return cached.state;
  }
  if (canReuseExact && !cached.eof) {
    // Resume partial progress from where the previous budget-bounded scan stopped
    state = cached.state;
    startOffset = cached.offset;
  } else if (canResumeAppend) {
    state = cached.state;
    startOffset = cached.offset;
  } else {
    state = {
      messages: [],
      artifacts: [],
      board: [],
      latestTranscriptMtimeMs: st.mtimeMs,
      inFlightUserStepIndex: -1,
      nextStep: 0,
      lastUser: "",
    };
  }

  const res = streamJsonlFromOffset(
    filePath,
    startOffset,
    (line) => handleExternalLineForSearch(entry.source, line, state),
    budget,
  );
  if (!res.ioError) {
    state.latestTranscriptMtimeMs = res.mtimeMs || st.mtimeMs;
    lruPut(extSearchCache, filePath, {
      offset: res.newOffset,
      eof: res.eof,
      mtimeMs: res.mtimeMs,
      size: res.size,
      state,
    });
  }
  return state;
}

export function isExternalDocCached(entry: SessionEntry): boolean {
  const cached = extSearchCache.get(entry.paths.transcriptPath);
  if (!cached || !cached.eof) return false;
  try {
    const st = fs.statSync(entry.paths.transcriptPath);
    return cached.size === st.size && cached.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}

export function parseExternalTurns(entry: SessionEntry): TranscriptTurn[] {
  const doc = getExternalSearchableDoc(entry);
  const turns: TranscriptTurn[] = [];
  let cur: TranscriptTurn | null = null;
  for (const m of doc.messages) {
    if (m.role === "user") {
      cur = {
        turnIndex: turns.length + 1,
        startStep: m.stepIndex,
        endStep: m.stepIndex,
        createdAt: m.date,
        userStepIndex: m.stepIndex,
        userText: m.text,
        userContentTruncated: false,
        assistantResponses: [],
        tools: [],
        thoughts: [],
        models: [entry.source],
        finalAssistantText: "",
        finalAssistantTruncated: false,
      };
      turns.push(cur);
    } else if (m.role === "assistant") {
      if (!cur) {
        cur = {
          turnIndex: turns.length + 1,
          startStep: m.stepIndex,
          endStep: m.stepIndex,
          createdAt: m.date,
          userStepIndex: -1,
          userText: "",
          userContentTruncated: false,
          assistantResponses: [],
          tools: [],
          thoughts: [],
          models: [entry.source],
          finalAssistantText: "",
          finalAssistantTruncated: false,
        };
        turns.push(cur);
      }
      cur.endStep = m.stepIndex;
      cur.assistantResponses.push({
        stepIndex: m.stepIndex,
        createdAt: m.date,
        text: m.text,
        contentTruncated: false,
      });
      cur.finalAssistantText = m.text;
    }
  }
  return turns;
}
