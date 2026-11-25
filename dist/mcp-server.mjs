#!/usr/bin/env node
// agy-memory MCP Stdio Server & CLI (bundled zero-dependency ESM)


// src/analytics.ts
import fs3 from "node:fs";
import path3 from "node:path";

// src/store.ts
import { execFileSync } from "node:child_process";
import fs2 from "node:fs";
import { createRequire } from "node:module";
import os2 from "node:os";
import path2 from "node:path";

// src/adapters.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var HEAD_META_BYTES = 16 * 1024;
var CHUNK_BYTES = 64 * 1024;
var MAX_CACHE = 48;
var extCatalogCache = /* @__PURE__ */ new Map();
var extHeadMetaCache = /* @__PURE__ */ new Map();
var extSearchCache = /* @__PURE__ */ new Map();
function lruPut(map, key, val, limit = MAX_CACHE) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first === void 0) break;
    map.delete(first);
  }
}
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
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
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
      const n = fs.readSync(fd, buf, 0, toRead, pos);
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
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function readHeadUtf8(filePath, maxBytes = HEAD_META_BYTES) {
  let fd = null;
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
      }
    }
  }
}
function emptyPaths(transcriptPath) {
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
    subagentsDir: ""
  };
}
function formatDateShort(ms) {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
function parseTs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw > 1e9 ? raw * 1e3 : raw;
  }
  if (typeof raw !== "string" || !raw.trim()) return 0;
  const ms = Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? 0 : ms;
}
function resolveCodexDir() {
  return (process.env.CODEX_HOME || "").trim() || path.join(os.homedir(), ".codex");
}
function resolveClaudeDir() {
  return (process.env.CLAUDE_CONFIG_DIR || "").trim() || path.join(os.homedir(), ".claude");
}
function walkJsonlFiles(rootDir, maxDepth = 4, skipDirNames = /* @__PURE__ */ new Set()) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let items;
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
function normalizeTextBlocks(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const obj = b;
    if (typeof obj.text === "string" && obj.text.trim()) {
      parts.push(obj.text.trim());
    }
  }
  return parts.join("\n").trim();
}
function isCodexSystemBoilerplate(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("<permissions instructions>") || t.startsWith("<environment_context>")) return true;
  if (t.startsWith("# AGENTS.md instructions for ") || t.startsWith("<INSTRUCTIONS>")) return true;
  return false;
}
function resolveToolPath(rawPath, primaryWorkspace) {
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
function statAllFiles(files) {
  const out = [];
  for (const filePath of files) {
    try {
      out.push({ filePath, st: fs.statSync(filePath) });
    } catch {
    }
  }
  return out;
}
function computeFullCatalogSig(indexMtime, statList) {
  return `${statList.length}|${indexMtime}|${statList.map((x) => `${x.filePath}:${Math.round(x.st.mtimeMs)}:${x.st.size}`).join("|")}`;
}
function loadCodexCatalog(codexDir = resolveCodexDir()) {
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
  const titles = /* @__PURE__ */ new Map();
  if (fs.existsSync(indexPath)) {
    try {
      for (const line of fs.readFileSync(indexPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.id) {
          titles.set(row.id, {
            title: String(row.thread_name || "").trim(),
            updatedMs: parseTs(row.updated_at)
          });
        }
      }
    } catch {
    }
  }
  statList.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const entries = [];
  for (const { filePath, st } of statList) {
    const fname = path.basename(filePath, ".jsonl");
    const idMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fname);
    const defaultId = idMatch ? idMatch[1] : fname;
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
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
          const p = obj.payload;
          if (p.id || p.session_id) sessionId = String(p.id || p.session_id).trim();
          if (!cwd && typeof p.cwd === "string") cwd = p.cwd.trim();
          if (!startedMs) startedMs = parseTs(p.timestamp || obj.timestamp);
        } else if (!firstUser && obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
          const p = obj.payload;
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
      paths: emptyPaths(filePath)
    });
  }
  entries.sort((a, b) => b.updatedMs - a.updatedMs);
  extCatalogCache.set(cacheKey, { sig, entries });
  return entries;
}
function loadClaudeCatalog(claudeDir = resolveClaudeDir()) {
  if (!fs.existsSync(claudeDir)) return [];
  const projectsDir = path.join(claudeDir, "projects");
  const transcriptsDir = path.join(claudeDir, "transcripts");
  const historyPath = path.join(claudeDir, "history.jsonl");
  const files = [
    ...walkJsonlFiles(projectsDir, 2, /* @__PURE__ */ new Set(["subagents"])),
    ...walkJsonlFiles(transcriptsDir, 2, /* @__PURE__ */ new Set(["subagents"]))
  ];
  const statList = statAllFiles(files);
  const historyMtime = fs.existsSync(historyPath) ? Math.round(fs.statSync(historyPath).mtimeMs) : 0;
  const sig = computeFullCatalogSig(historyMtime, statList);
  const cacheKey = `claude:${claudeDir}`;
  const cached = extCatalogCache.get(cacheKey);
  if (cached && cached.sig === sig) return cached.entries;
  const historyMeta = /* @__PURE__ */ new Map();
  if (fs.existsSync(historyPath)) {
    try {
      for (const line of fs.readFileSync(historyPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.sessionId) {
          const prev = historyMeta.get(row.sessionId);
          const ts = parseTs(row.timestamp);
          historyMeta.set(row.sessionId, {
            project: String(row.project || prev?.project || "").trim(),
            title: String(row.display || prev?.title || "").replace(/\s+/g, " ").trim().slice(0, 80),
            updatedMs: Math.max(ts, prev?.updatedMs || 0)
          });
        }
      }
    } catch {
    }
  }
  const seenIds = /* @__PURE__ */ new Set();
  const entries = [];
  for (const { filePath, st } of statList) {
    const baseId = path.basename(filePath, ".jsonl");
    const headSig = `${Math.round(st.mtimeMs)}:${st.size}`;
    let meta = extHeadMetaCache.get(filePath);
    if (!meta || meta.sig !== headSig) {
      let embeddedId = "";
      let cwd2 = "";
      let firstUser = "";
      let startedMs = 0;
      let isSidechain = baseId.startsWith("agent-");
      const head = readHeadUtf8(filePath, HEAD_META_BYTES);
      for (const line of head.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.isSidechain === true) isSidechain = true;
        if (!embeddedId && typeof obj.sessionId === "string" && obj.sessionId.trim()) {
          embeddedId = obj.sessionId.trim();
        }
        if (!cwd2 && typeof obj.cwd === "string" && obj.cwd.trim()) cwd2 = obj.cwd.trim();
        if (!startedMs) startedMs = parseTs(obj.timestamp);
        if (!firstUser && obj.type === "user") {
          const msg = obj.message;
          const txt = msg ? normalizeTextBlocks(msg.content) : normalizeTextBlocks(obj.content);
          if (txt) firstUser = txt.replace(/\s+/g, " ").slice(0, 120);
        }
      }
      const sessionId = isSidechain ? baseId : embeddedId || baseId;
      meta = { sig: headSig, sessionId, cwd: cwd2, startedMs, firstUser, isSidechain };
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
      paths: emptyPaths(filePath)
    });
  }
  entries.sort((a, b) => b.updatedMs - a.updatedMs);
  extCatalogCache.set(cacheKey, { sig, entries });
  return entries;
}
function handleExternalLineForSearch(source, line, state) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }
  const idx = state.nextStep;
  state.nextStep += 1;
  const date = formatDateShort(parseTs(obj.timestamp));
  if (source === "codex") {
    if (obj.type === "response_item" && obj.payload && typeof obj.payload === "object") {
      const p = obj.payload;
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        const text = normalizeTextBlocks(p.content);
        if (!text || p.role === "user" && isCodexSystemBoilerplate(text)) return;
        const msg = {
          stepIndex: idx,
          role: p.role,
          date,
          text,
          lowText: text.toLowerCase()
        };
        state.messages.push(msg);
      }
    } else if (obj.type === "event_msg" && obj.payload && typeof obj.payload === "object") {
      const p = obj.payload;
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
      const msgObj = obj.message;
      const text = msgObj ? normalizeTextBlocks(msgObj.content) : normalizeTextBlocks(obj.content);
      if (!text) return;
      state.messages.push({
        stepIndex: idx,
        role: obj.type,
        date,
        text,
        lowText: text.toLowerCase()
      });
    }
  }
}
function getExternalSearchableDoc(entry, budget) {
  const filePath = entry.paths.transcriptPath;
  let st;
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
  let state;
  let startOffset = 0;
  const canReuseExact = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
  const canResumeAppend = cached && cached.eof && cached.size < st.size;
  if (canReuseExact && cached.eof) {
    return cached.state;
  }
  if (canReuseExact && !cached.eof) {
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
      lastUser: ""
    };
  }
  const res = streamJsonlFromOffset(
    filePath,
    startOffset,
    (line) => handleExternalLineForSearch(entry.source, line, state),
    budget
  );
  if (!res.ioError) {
    state.latestTranscriptMtimeMs = res.mtimeMs || st.mtimeMs;
    lruPut(extSearchCache, filePath, {
      offset: res.newOffset,
      eof: res.eof,
      mtimeMs: res.mtimeMs,
      size: res.size,
      state
    });
  }
  return state;
}
function isExternalDocCached(entry) {
  const cached = extSearchCache.get(entry.paths.transcriptPath);
  if (!cached || !cached.eof) return false;
  try {
    const st = fs.statSync(entry.paths.transcriptPath);
    return cached.size === st.size && cached.mtimeMs === st.mtimeMs;
  } catch {
    return false;
  }
}
function parseExternalTurns(entry) {
  const doc = getExternalSearchableDoc(entry);
  const turns = [];
  let cur = null;
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
        finalAssistantTruncated: false
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
          finalAssistantTruncated: false
        };
        turns.push(cur);
      }
      cur.endStep = m.stepIndex;
      cur.assistantResponses.push({
        stepIndex: m.stepIndex,
        createdAt: m.date,
        text: m.text,
        contentTruncated: false
      });
      cur.finalAssistantText = m.text;
    }
  }
  return turns;
}

// src/store.ts
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
    const st = fs2.statSync(filePath);
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
  if (fs2.existsSync(cliDir)) return cliDir;
  const ideDir = path2.join(os2.homedir(), ".gemini", "antigravity");
  if (fs2.existsSync(ideDir)) return ideDir;
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
var VALID_SOURCES = /* @__PURE__ */ new Set(["agy", "codex", "claude", "all"]);
function parseSourceFilter(raw) {
  const s = String(raw ?? "agy").trim().toLowerCase() || "agy";
  if (VALID_SOURCES.has(s)) {
    return { source: s, error: null };
  }
  return {
    source: "agy",
    error: `Error: Invalid source "${String(raw)}". Expected one of: agy, codex, claude, all.`
  };
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
    fd = fs2.openSync(filePath, "r");
    const size = fs2.fstatSync(fd).size;
    if (size <= 0) return { text: "", totalSize: 0 };
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs2.readSync(fd, buf, 0, length, start);
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
        fs2.closeSync(fd);
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
    const names = fs2.readdirSync(brainDir).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    return names.map((name) => {
      const filePath = path2.join(brainDir, name);
      let updatedAt = 0;
      let size = 0;
      try {
        const st = fs2.statSync(filePath);
        updatedAt = st.mtimeMs || 0;
        size = st.size || 0;
      } catch {
      }
      let summary = "";
      if (includeMeta) {
        const metaPath = `${filePath}.metadata.json`;
        try {
          const meta = JSON.parse(fs2.readFileSync(metaPath, "utf8"));
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
    dirs = fs2.readdirSync(brainRoot);
  } catch {
    return [];
  }
  const childIds = /* @__PURE__ */ new Set();
  for (const id of dirs) {
    const p = getSessionPaths(dataDir, id);
    try {
      const subFiles = fs2.readdirSync(p.subagentsDir).filter((f) => f.endsWith(".json"));
      for (const f of subFiles) childIds.add(f.replace(/\.json$/, ""));
    } catch {
    }
    try {
      const members = JSON.parse(fs2.readFileSync(p.swarmMembersPath, "utf8"));
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
      st = fs2.statSync(p.transcriptPath);
    } catch {
      try {
        st = fs2.statSync(p.brainDir);
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
      if (!entry.hasTranscript && fs2.existsSync(entry.paths.transcriptPath)) {
        entry.hasTranscript = true;
      }
      if (!entry.hasSwarm && (fs2.existsSync(entry.paths.swarmMembersPath) || fs2.existsSync(entry.paths.swarmBoardPath))) {
        entry.hasSwarm = true;
      }
    }
    return cached.entries;
  }
  const dbPath = path2.join(resolvedDir, "conversation_summaries.db");
  let rawRows = null;
  if (fs2.existsSync(dbPath)) {
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
    for (const id of fs2.readdirSync(brainRoot)) {
      if (id.startsWith(".") || seen.has(id)) continue;
      const p = getSessionPaths(resolvedDir, id);
      if (!fs2.existsSync(p.transcriptPath)) continue;
      const st = fs2.statSync(p.transcriptPath);
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
    const hasTranscript = fs2.existsSync(paths.transcriptPath);
    const hasSwarm = fs2.existsSync(paths.swarmMembersPath) || fs2.existsSync(paths.swarmBoardPath);
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
function loadFederatedCatalog(dataDir = resolveDataDir(), source = "agy") {
  const sourceCounts = {};
  let entries = [];
  if (source === "agy" || source === "all") {
    const agy = loadSessionCatalog(dataDir);
    sourceCounts.agy = agy.length;
    entries = entries.concat(agy);
  }
  if (source === "codex" || source === "all") {
    const codex = loadCodexCatalog();
    sourceCounts.codex = codex.length;
    entries = entries.concat(codex);
  }
  if (source === "claude" || source === "all") {
    const claude = loadClaudeCatalog();
    sourceCounts.claude = claude.length;
    entries = entries.concat(claude);
  }
  if (source === "all") {
    entries.sort((a, b) => b.updatedMs - a.updatedMs);
  }
  const coverageLabel = Object.entries(sourceCounts).map(([k, v]) => `${k}:${v}`).join(", ");
  return { entries, sourceCounts, coverageLabel };
}
function resolveSessionEntry(dataDir, sessionRef, catalog = null, sourceFilter = "agy") {
  const rawRef = String(sessionRef || "").trim();
  if (!rawRef) return { entry: null, error: "sessionId is required." };
  const { source: explicitSource, id: bareRef } = splitCanonicalRef(rawRef);
  const ref = bareRef.toLowerCase();
  const effectiveSource = explicitSource || sourceFilter;
  const list = catalog || loadFederatedCatalog(dataDir, effectiveSource).entries;
  const scoped = explicitSource ? list.filter((s) => s.source === explicitSource) : list;
  const exactMatches = scoped.filter((s) => s.sessionId.toLowerCase() === ref);
  if (exactMatches.length === 1) return { entry: exactMatches[0], error: null };
  if (exactMatches.length > 1) {
    const listStr = exactMatches.map((m) => `${m.canonicalId} (${m.title || "untitled"})`).join(", ");
    return {
      entry: null,
      error: `Ambiguous session ID "${sessionRef}" across harnesses; qualify with source prefix: ${listStr}`
    };
  }
  if (ref.length < 4) {
    return { entry: null, error: `Session prefix "${sessionRef}" is too short (use at least 4 characters).` };
  }
  const matches = scoped.filter((s) => s.sessionId.toLowerCase().startsWith(ref));
  if (matches.length === 1) return { entry: matches[0], error: null };
  if (matches.length > 1) {
    const listStr = matches.slice(0, 5).map((m) => `${m.source === "agy" && effectiveSource === "agy" ? m.shortId : `${m.source}:${m.shortId}`} (${m.title || "untitled"})`).join(", ");
    return { entry: null, error: `Ambiguous session prefix "${sessionRef}"; matches: ${listStr}` };
  }
  return { entry: null, error: `No local conversation found matching "${sessionRef}" (source=${effectiveSource}).` };
}
function loadFullTranscriptStepMap(transcriptFullPath) {
  if (!transcriptFullPath || !fs2.existsSync(transcriptFullPath)) return null;
  const sig = statSignature(transcriptFullPath);
  const cached = fullStepsCache.get(transcriptFullPath);
  if (cached && cached.sig === sig) {
    return cached.stepMap;
  }
  let raw = "";
  try {
    raw = fs2.readFileSync(transcriptFullPath, "utf8");
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
      raw = fs2.readFileSync(transcriptPath, "utf8");
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
  if (!swarmBoardPath || !fs2.existsSync(swarmBoardPath)) return [];
  let raw = "";
  try {
    raw = fs2.readFileSync(swarmBoardPath, "utf8");
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
  if (entry.source !== "agy") {
    return getExternalSearchableDoc(entry, budget);
  }
  const cacheKey = entry.canonicalId;
  const transcriptSig = entry.hasTranscript ? statSignature(entry.paths.transcriptPath) : "none";
  const fullSig = includeFullTranscript && entry.hasTranscript && fs2.existsSync(entry.paths.transcriptFullPath) ? statSignature(entry.paths.transcriptFullPath) : "none";
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
      const st = fs2.statSync(entry.paths.transcriptPath);
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
      const content = fs2.readFileSync(art.path, "utf8");
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
  if (entry.source !== "agy") return isExternalDocCached(entry);
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
function listSessionsResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    source = "agy",
    workspace = "",
    query = "",
    includeChildren = false,
    excludeSessionId = "",
    sinceHours = 0,
    minSteps = 0,
    limit = 15,
    maxChars = 8200
  } = opts;
  const parsedSource = parseSourceFilter(source);
  if (parsedSource.error) {
    return { text: parsedSource.error, isError: true };
  }
  const safeSource = parsedSource.source;
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const safeMinSteps = Math.max(0, Number(minSteps) || 0);
  const { entries: catalog, coverageLabel } = loadFederatedCatalog(dataDir, safeSource);
  const now = Date.now();
  const minMs = sinceHours > 0 ? now - sinceHours * 3600 * 1e3 : 0;
  const queryTerms = parseQueryTokens(query);
  const filtered = [];
  for (const s of catalog) {
    if (!includeChildren && s.isChild) continue;
    if (excludeSessionId && matchesSessionId(s.sessionId, excludeSessionId, s.source)) continue;
    if (minMs > 0 && s.updatedMs < minMs) continue;
    if (safeMinSteps > 0 && s.stepCount < safeMinSteps) continue;
    if (!workspaceMatches(s.workspaces, workspace)) continue;
    let lastPrompt = "";
    if (queryTerms.length > 0) {
      const baseHay = `${s.source} ${s.title} ${s.preview} ${s.sessionId} ${s.workspaces.join(" ")}`.toLowerCase();
      let matched = queryTerms.every((t) => baseHay.includes(t));
      if (!matched && s.hasTranscript && s.source === "agy") {
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
    return {
      text: `No matching conversations found (sources: ${coverageLabel}${workspace ? `, workspace~"${workspace}"` : ""}).`,
      isError: false
    };
  }
  const lines = [
    `Recent conversations (${filtered.length} shown; sources: ${coverageLabel}${workspace ? `, workspace~"${workspace}"` : ""}${safeMinSteps > 0 ? `, minSteps>=${safeMinSteps}` : ""}):`,
    ""
  ];
  for (const s of filtered) {
    const snippet = s.lastPrompt || (s.hasTranscript && s.source === "agy" ? readLastUserPromptSnippet(s.paths.transcriptPath, 120, { preferSubstantive: true }) : s.preview && s.preview !== s.title ? s.preview : "");
    const artifacts = s.source === "agy" ? listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false }) : [];
    const wsName = s.workspaces.length > 0 ? s.workspaces[0] ?? "" : "";
    const wsLabel = wsName ? formatWorkspaceLabel(wsName) : "";
    const badges = [];
    if (s.source !== "agy" || safeSource === "all") badges.push(s.source);
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
    const dispId = s.source === "agy" ? s.shortId : `${s.source}:${s.shortId}`;
    const fullId = s.source === "agy" ? s.sessionId : s.canonicalId;
    lines.push(`- **${dispId}** (${fullId}) \u2014 ${title}${badgeStr}`);
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
    const membersObj = JSON.parse(fs2.readFileSync(entry.paths.swarmMembersPath, "utf8"));
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
        const content = fs2.readFileSync(a.path, "utf8");
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
  const allLines = splitFileLines(fs2.readFileSync(target.path, "utf8"));
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
    source = "agy",
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
  const parsedSource = parseSourceFilter(source);
  if (parsedSource.error) {
    return { text: parsedSource.error, isError: true };
  }
  const safeMode = String(mode || "digest").trim().toLowerCase();
  if (!VALID_READ_MODES.has(safeMode)) {
    return {
      text: `Error: Invalid mode "${mode}". Expected one of: digest, turns, artifacts, swarm.`,
      isError: true
    };
  }
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const { entry, error } = resolveSessionEntry(dataDir, sessionId, null, parsedSource.source);
  if (error || !entry) {
    return { text: `Error: ${error || "Session not found."}`, isError: true };
  }
  const artifacts = entry.source === "agy" ? listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: safeMode === "artifacts" }) : [];
  const wsStr = entry.workspaces.join(", ") || "(unknown)";
  if (safeMode === "artifacts") {
    return formatArtifactsMode(entry, artifacts, { artifactName, startLine, endLine, safeMaxChars });
  }
  if (safeMode === "swarm") {
    return formatSwarmMode(entry, { tailMessages, startSeq, endSeq, query, safeMaxChars });
  }
  const turns = entry.source === "agy" ? parseTranscriptTurns(entry.paths.transcriptPath, {
    hydrateFull: safeMode === "turns",
    transcriptFullPath: entry.paths.transcriptFullPath
  }) : parseExternalTurns(entry);
  if (turns.length === 0) {
    return {
      text: `Session ${entry.source === "agy" ? entry.shortId : entry.canonicalId} (${entry.title || "untitled"}) has no readable transcript turns yet.`,
      isError: false
    };
  }
  const firstStep = turns[0].startStep;
  const lastStep = turns[turns.length - 1].endStep;
  const headerLines = [
    `Session: ${entry.source === "agy" ? entry.sessionId : entry.canonicalId} (source=${entry.source})`,
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
      const m = JSON.parse(fs2.readFileSync(entry.paths.swarmMembersPath, "utf8"));
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
      const tipId = entry.source === "agy" ? entry.shortId : `${entry.source}:${entry.shortId}`;
      out.push(
        `
Tip: use search_sessions(sessionId="${tipId}", query="...") to jump to specific topics, or read_session(sessionId="${tipId}", mode="turns", startStep=..., endStep=...).`
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
    raw = fs3.readFileSync(transcriptPath, "utf8");
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
    dataDir: path3.resolve(dataDir),
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
import fs4 from "node:fs";
import path4 from "node:path";
var INDEX_START = "<!-- agy-memory:index:start -->";
var INDEX_END = "<!-- agy-memory:index:end -->";
var MAX_INDEX_LINES = 150;
var FRONTMATTER_SCHEMA_VERSION = 1;
var VALID_NOTE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
var LOCK_TIMEOUT_MS = 1500;
var STALE_LOCK_MS = 1e4;
function getNotesPath(dataDir = resolveDataDir()) {
  return path4.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}
function getMemoryDir(dataDir = resolveDataDir()) {
  return path4.join(dataDir, "plugin_data", "agy-memory", "memory");
}
function getMemoryIndexPath(dataDir = resolveDataDir()) {
  return path4.join(getMemoryDir(dataDir), "MEMORY.md");
}
function getTopicsDir(dataDir = resolveDataDir()) {
  return path4.join(getMemoryDir(dataDir), "topics");
}
function isValidNoteId(id) {
  return VALID_NOTE_ID_RE.test(id);
}
function getTopicFilePath(dataDir, validatedId) {
  if (!isValidNoteId(validatedId)) {
    throw new Error(`Invalid note ID "${validatedId}". Use 1-64 ASCII letters, digits, '_' or '-' starting with a letter/digit.`);
  }
  return path4.join(getTopicsDir(dataDir), `${validatedId}.md`);
}
function computeRevision(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}
function writeTextAtomic(filePath, payload) {
  const dir = path4.dirname(filePath);
  fs4.mkdirSync(dir, { recursive: true, mode: 448 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs4.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 384, flag: "wx" });
    fs4.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs4.unlinkSync(tmpPath);
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
  fs4.mkdirSync(memDir, { recursive: true, mode: 448 });
  const lockPath = path4.join(memDir, ".notes.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs4.openSync(lockPath, "wx", 384);
      fs4.writeSync(fd, `${process.pid}:${Date.now()}
`);
      fs4.closeSync(fd);
      acquired = true;
    } catch (err) {
      const code = err?.code;
      if (code !== "EEXIST") throw err;
      try {
        const st = fs4.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs4.unlinkSync(lockPath);
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
      fs4.unlinkSync(lockPath);
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
    stMtime = Math.round(fs4.statSync(filePath).mtimeMs);
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
    const relName = n.filePath ? path4.basename(n.filePath) : `${n.id}.md`;
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
  if (fs4.existsSync(indexPath)) {
    try {
      const existing = fs4.readFileSync(indexPath, "utf8").replace(/\r\n/g, "\n");
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
  if (!fs4.existsSync(topicsDir)) return [];
  const notes = [];
  const seenIds = /* @__PURE__ */ new Map();
  let entries = [];
  try {
    entries = fs4.readdirSync(topicsDir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort();
  } catch {
    return [];
  }
  for (const name of entries) {
    const filePath = path4.join(topicsDir, name);
    try {
      const raw = fs4.readFileSync(filePath, "utf8");
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
  if (!fs4.existsSync(filePath)) return { notes: [], warnings };
  try {
    const parsed = JSON.parse(fs4.readFileSync(filePath, "utf8"));
    const notes = Array.isArray(parsed?.notes) ? parsed.notes : [];
    return { notes, warnings };
  } catch {
    warnings.push(`Malformed legacy notes file preserved untouched: ${filePath}`);
    return { notes: [], warnings };
  }
}
function maybeMigrateLegacyNotesJson(dataDir, warnings) {
  const legacyPath = getNotesPath(dataDir);
  if (!fs4.existsSync(legacyPath)) return;
  const markerPath = path4.join(getMemoryDir(dataDir), ".migrated_v1_json");
  if (fs4.existsSync(markerPath)) return;
  withNotesLock(dataDir, () => {
    if (fs4.existsSync(markerPath)) return;
    let legacyNotes = [];
    try {
      const parsed = JSON.parse(fs4.readFileSync(legacyPath, "utf8"));
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
    fs4.mkdirSync(topicsDir, { recursive: true, mode: 448 });
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
      if (fs4.existsSync(dst)) {
        try {
          const existingParsed = parseTopicMarkdown(fs4.readFileSync(dst, "utf8"), dst);
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
      const verify = parseTopicMarkdown(fs4.readFileSync(dst, "utf8"), dst);
      if (!verify.note || verify.note.id !== normalized.id || verify.note.topic !== normalized.topic || verify.note.content !== normalized.content) {
        allVerified = false;
        warnings.push(`Migration verification failed for note ${id}; legacy notes.json retained.`);
      } else {
        migratedAny = true;
      }
    }
    if (migratedAny || fs4.existsSync(topicsDir)) {
      const freshWarnings = [];
      const currentNotes = readTopicsFromDisk(dataDir, freshWarnings);
      if (currentNotes.length > 0 && !fs4.existsSync(getMemoryIndexPath(dataDir))) {
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
    if (topicNotes.length > 0 || fs4.existsSync(topicsDir)) {
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
function saveNoteResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    id = "",
    deleteId = "",
    topic = "",
    content = "",
    workspace,
    tags,
    sessionId = "",
    expectedRevision = ""
  } = opts;
  const cleanExpectedRev = String(expectedRevision || "").trim();
  try {
    return withNotesLock(dataDir, () => {
      const warnings = [];
      maybeMigrateLegacyNotesJson(dataDir, warnings);
      const notes = readTopicsFromDisk(dataDir, warnings);
      const memoryIndexPath = getMemoryIndexPath(dataDir);
      if (deleteId) {
        const target = String(deleteId).trim();
        if (!isValidNoteId(target)) {
          return { text: `Error: Invalid deleteId "${target}".`, isError: true };
        }
        const existing2 = notes.find((n) => n.id === target);
        if (!existing2 || !existing2.filePath || !fs4.existsSync(existing2.filePath)) {
          return { text: `Error: Note "${target}" not found.`, isError: true };
        }
        const liveRaw = fs4.readFileSync(existing2.filePath, "utf8");
        const liveRev = computeRevision(liveRaw);
        if (cleanExpectedRev && cleanExpectedRev !== liveRev) {
          return {
            text: `Error: Revision conflict deleting note [${target}] (expected ${cleanExpectedRev}, live ${liveRev}). Live file preserved untouched.
Path: ${existing2.filePath}
Revision: ${liveRev}`,
            isError: true
          };
        }
        fs4.unlinkSync(existing2.filePath);
        const freshAfter = readTopicsFromDisk(dataDir, []);
        rebuildMemoryIndexFile(dataDir, freshAfter);
        return {
          text: `Deleted note ${target} (${existing2.filePath}). (${freshAfter.length} note(s) remaining)`,
          isError: false
        };
      }
      const cleanTopic = String(topic || "").trim();
      const cleanContent = String(content || "").replace(/^\n+/, "").trimEnd();
      if (!cleanTopic || !cleanContent.trim()) {
        return {
          text: "Error: both `topic` and `content` are required (or pass `deleteId` to remove a note).",
          isError: true
        };
      }
      const cleanId = String(id || "").trim();
      if (cleanId && !isValidNoteId(cleanId)) {
        return {
          text: `Error: Invalid note id "${cleanId}". Use 1-64 ASCII letters, digits, '_' or '-' starting with a letter/digit.`,
          isError: true
        };
      }
      const hasWorkspaceArg = workspace !== void 0;
      const hasTagsArg = tags !== void 0;
      const cleanWsArg = hasWorkspaceArg ? String(workspace || "").trim() : "";
      const cleanTagsArg = hasTagsArg ? normalizeTagsInput(tags) : [];
      const now = Date.now();
      const existing = cleanId ? notes.find((n) => n.id === cleanId) : notes.find(
        (n) => n.topic.toLowerCase() === cleanTopic.toLowerCase() && n.workspace.toLowerCase() === cleanWsArg.toLowerCase()
      );
      if (cleanExpectedRev && !existing) {
        return {
          text: `Error: Revision conflict \u2014 note "${cleanId || cleanTopic}" does not exist on disk (expected revision ${cleanExpectedRev}). Refusing to recreate.`,
          isError: true
        };
      }
      const noteId = existing ? existing.id : cleanId || crypto.randomBytes(4).toString("hex");
      const topicPath = existing?.filePath || getTopicFilePath(dataDir, noteId);
      if (!existing && fs4.existsSync(topicPath)) {
        return {
          text: `Error: Destination file already exists for id "${noteId}" (${topicPath}). Refusing to overwrite an unreadable or untracked file.`,
          isError: true
        };
      }
      if (existing && fs4.existsSync(topicPath)) {
        const liveRaw = fs4.readFileSync(topicPath, "utf8");
        const liveRev = computeRevision(liveRaw);
        if (cleanExpectedRev && cleanExpectedRev !== liveRev) {
          return {
            text: `Error: Revision conflict updating note [${noteId}] (expected ${cleanExpectedRev}, live ${liveRev}). Live file preserved untouched; re-read before retrying.
Path: ${topicPath}
Revision: ${liveRev}`,
            isError: true
          };
        }
      }
      const saved = existing ? {
        ...existing,
        topic: cleanTopic,
        content: cleanContent,
        workspace: hasWorkspaceArg ? cleanWsArg : existing.workspace,
        tags: hasTagsArg ? cleanTagsArg : existing.tags || [],
        sessionId: sessionId || existing.sessionId || "",
        updatedAt: now,
        filePath: topicPath
      } : {
        id: noteId,
        topic: cleanTopic,
        content: cleanContent,
        workspace: cleanWsArg,
        tags: cleanTagsArg,
        sessionId: String(sessionId || ""),
        createdAt: now,
        updatedAt: now,
        filePath: topicPath
      };
      const md = serializeTopicMarkdown(saved);
      saved.revision = computeRevision(md);
      writeTextAtomic(topicPath, md);
      const freshNotes = readTopicsFromDisk(dataDir, []);
      rebuildMemoryIndexFile(dataDir, freshNotes);
      const verb = existing ? "Updated" : "Saved";
      const tagNote = saved.tags.length > 0 ? ` [${saved.tags.join(", ")}]` : "";
      const wsNote = saved.workspace ? ` (${saved.workspace})` : "";
      const warnNote = warnings.length > 0 ? `
Warnings: ${warnings.join("; ")}` : "";
      return {
        text: `${verb} note [${saved.id}] "${saved.topic}"${tagNote}${wsNote}.
Path: ${topicPath}
Revision: ${saved.revision}
Index: ${memoryIndexPath}${warnNote}`,
        isError: false
      };
    });
  } catch (err) {
    return {
      text: `Error saving note: ${err instanceof Error ? err.message : String(err)}`,
      isError: true
    };
  }
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
  const { notes, warnings, memoryIndexPath } = loadNotesWithDiagnostics(dataDir);
  const warnBlock = warnings.length > 0 ? `

Warnings:
${warnings.map((w) => `- ${w}`).join("\n")}` : "";
  if (notes.length === 0) {
    return { text: `No saved cross-session notes yet.${warnBlock}`, isError: false };
  }
  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const terms = parseQueryTokens(query);
  const tagFilter = String(tag || "").trim().toLowerCase();
  const filtered = notes.filter((n) => {
    if (workspace && !noteWorkspaceMatches(n.workspace, workspace)) return false;
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
      text: `No saved notes matched your filter (${notes.length} total notes stored).${warnBlock}`,
      isError: false
    };
  }
  const now = Date.now();
  const lines = [
    `Saved cross-session notes (${filtered.length} of ${notes.length}; Index: ${memoryIndexPath}):`
  ];
  for (const n of filtered) {
    const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const wsLabel = n.workspace ? formatWorkspaceLabel(n.workspace) : "";
    const wsPart = wsLabel ? ` \xB7 ${wsLabel}` : "";
    const srcPart = n.sessionId ? ` \xB7 from ${n.sessionId.slice(0, 8)}` : "";
    lines.push(
      `
- **[${n.id}] ${n.topic}**${tagPart} (${formatShortDate(n.updatedAt)}, ${formatRelativeTime(n.updatedAt, now)}${wsPart}${srcPart})`
    );
    if (n.filePath) {
      const lineCount = n.content.split("\n").length;
      const revPart = n.revision ? ` \xB7 Revision: ${n.revision}` : "";
      lines.push(`  Path: ${n.filePath} (${lineCount} lines${revPart})`);
    }
    const body = n.content.length > 1200 && n.filePath ? `${safeSliceChars(n.content, 1180)}\u2026 (use read_file on Path for full note)` : n.content;
    lines.push(`  ${body}`);
  }
  if (warnBlock) lines.push(warnBlock);
  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

// src/search.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import fs6 from "node:fs";

// src/trace.ts
import fs5 from "node:fs";
import path5 from "node:path";
var MAX_TRACE_CACHE = 48;
var IS_WIN = process.platform === "win32";
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
function unwrapAgyArgValue(v) {
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
    out[k] = unwrapAgyArgValue(v);
  }
  return out;
}
function extractAgyPaths(toolName, args) {
  const low = toolName.toLowerCase();
  const out = [];
  const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
  const pushPath = (raw, isWrite) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const val = raw.trim();
    const joined = cwd && !path5.isAbsolute(val) && !/^[a-zA-Z]:[\\/]/.test(val) ? path5.posix.join(cwd.replace(/\\/g, "/"), val) : val;
    out.push({ path: joined, isWrite });
  };
  if (low === "edit_file" || low === "write_file" || low === "replace_file_content" || low === "multi_replace_file_content" || low === "write_to_file") {
    pushPath(args.Path ?? args.TargetFile ?? args.path, true);
    return out;
  }
  if (low === "mcp_agy-fast_fast_apply_edits" || low === "apply_edits") {
    if (Array.isArray(args.edits)) {
      for (const e of args.edits) {
        if (e && typeof e === "object") pushPath(e.path, true);
      }
    }
    return out;
  }
  if (low === "read_file" || low === "view_file") {
    pushPath(args.Path ?? args.AbsolutePath ?? args.path, false);
    return out;
  }
  if (low === "mcp_agy-fast_fast_quick_outline" || low === "quick_outline") {
    if (Array.isArray(args.paths)) {
      for (const p of args.paths) pushPath(p, false);
    }
    return out;
  }
  if (low === "mcp_agy-fast_fast_read_slices" || low === "read_slices") {
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
function stripAgyTimestampHeader(text) {
  return text.replace(/^(?:(?:Created At|Completed At):\s*[^\n]+\n?)+/gi, "").replace(/\s+/g, " ").trim();
}
function isLikelyToolResponse(rawGeneric) {
  if (!rawGeneric.trim()) return false;
  if (/^(?:Created At|Completed At):/i.test(rawGeneric)) return true;
  if (/^(?:Made \d+ replacement|Created file\.|Appended to file\.|Overwrote file\.|Showing lines |Command exited with code|The tool's output was truncated|Successfully |Encountered error in tool execution|Error:|Applied \d+ edit)/i.test(rawGeneric.trim())) {
    return true;
  }
  if (/^<(?:SYSTEM_MESSAGE|USER_REQUEST|CONTEXT_SUMMARY)/i.test(rawGeneric.trim())) return false;
  return true;
}
function parseAgyGenericOutcome(content) {
  const cleaned = stripAgyTimestampHeader(content);
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
  if (entry.source !== "agy") {
    return { fileEvents: [], errorEvents: [], passEvents: [] };
  }
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
    const cleaned = stripAgyTimestampHeader(genericContent);
    const call = pickMatchingPendingCall(state.pendingBatch, cleaned);
    if (!call) return;
    const outcome = parseAgyGenericOutcome(genericContent);
    const pathHits = extractAgyPaths(call.name, call.args);
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
    const isCmd = call.name === "run_command" || call.name === "mcp_agy-fast_fast_run_checks";
    const invocation = cmdLine ? cmdLine.split(/\r?\n/)[0].slice(0, 160) : pathHits[0] ? `${call.name} ${pathHits[0].path}` : call.name;
    const cmdKey = cmdLine ? buildFullCommandKey(cmdLine, cmdCwd) : `${call.name.toLowerCase()}:${pathHits[0]?.path || ""}`;
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
  const { eligible, query, sourceCoverage, maxSessions, maxChars } = opts;
  const cleanQuery = String(query || "").trim().replace(/\\/g, "/").replace(/^["']|["']$/g, "");
  if (!cleanQuery) {
    return { text: "Error: query (file path or filename) is required for mode='file_history'.", isError: true };
  }
  const agyEligible = eligible.filter((e) => e.source === "agy");
  const skippedExt = eligible.length - agyEligible.length;
  if (agyEligible.length === 0 && skippedExt > 0) {
    return {
      text: `Trace mode "file_history" currently supports Antigravity (agy) sessions only so every cited #step round-trips through read_session(mode="turns"). Use mode="text" for Codex/Claude sessions.`,
      isError: true
    };
  }
  const queryNorm = normalizeForMatch(cleanQuery);
  const isBasenameQuery = !queryNorm.includes("/");
  const budget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();
  const hits = [];
  const distinctPaths = /* @__PURE__ */ new Map();
  for (const entry of agyEligible) {
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
  const scopeNote = skippedExt > 0 ? `${sourceCoverage}; agy-only for trace` : sourceCoverage;
  const coverageBanner = budget.incomplete ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${agyEligible.length} agy sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays \u2014 do NOT treat 0-match as authoritative).` : `Complete scan: ${budget.sessionsScanned}/${agyEligible.length} agy sessions (${scopeNote}).`;
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
      lines.push(`Write steps: ${steps.join(", ")} (use read_session(sessionId="${e.shortId}", mode="turns", startStep, endStep) for verbatim context)`);
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
  const { eligible, query, sourceCoverage, maxSessions, maxChars } = opts;
  const terms = parseQueryTokens(query);
  if (terms.length === 0) {
    return { text: "Error: query (error pattern or command keyword) is required for mode='error_history'.", isError: true };
  }
  const agyEligible = eligible.filter((e) => e.source === "agy");
  const skippedExt = eligible.length - agyEligible.length;
  if (agyEligible.length === 0 && skippedExt > 0) {
    return {
      text: `Trace mode "error_history" currently supports Antigravity (agy) sessions only so every cited #step round-trips through read_session(mode="turns"). Use mode="text" for Codex/Claude sessions.`,
      isError: true
    };
  }
  const budget = createScanBudget(opts.maxScanBytes, opts.maxScanMs);
  const now = Date.now();
  const hits = [];
  for (const entry of agyEligible) {
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
  const scopeNote = skippedExt > 0 ? `${sourceCoverage}; agy-only for trace` : sourceCoverage;
  const coverageBanner = budget.incomplete ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${agyEligible.length} agy sessions, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays \u2014 do NOT treat 0-match as authoritative).` : `Complete scan: ${budget.sessionsScanned}/${agyEligible.length} agy sessions (${scopeNote}).`;
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
    if (wantArtifacts && entry.source === "agy") {
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
function searchSessionsResult(opts = {}) {
  const {
    dataDir = resolveDataDir(),
    query = "",
    mode = "text",
    source = "agy",
    scope = "all",
    regex: isRegex = false,
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
  const parsedSource = parseSourceFilter(source);
  if (parsedSource.error) {
    return { text: parsedSource.error, isError: true };
  }
  const targetSessionRef = String(sessionId || "").trim();
  const explicitTargetSrc = targetSessionRef ? splitCanonicalRef(targetSessionRef).source : null;
  const effectiveSource = explicitTargetSrc || parsedSource.source;
  const safeMaxSessions = Math.max(1, Math.min(25, Number(maxSessions) || 10));
  const safeMaxSnippets = Math.max(1, Math.min(8, Number(maxSnippetsPerSession) || 3));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const { entries: catalog, coverageLabel } = loadFederatedCatalog(dataDir, effectiveSource);
  const now = Date.now();
  const minMs = sinceDays > 0 ? now - sinceDays * 24 * 3600 * 1e3 : 0;
  let eligible;
  if (targetSessionRef) {
    const resolved = resolveSessionEntry(dataDir, targetSessionRef, catalog, effectiveSource);
    if (!resolved.entry) {
      return { text: `Error: ${resolved.error || `No conversation matched "${targetSessionRef}".`}`, isError: true };
    }
    const s = resolved.entry;
    const excluded = excludeSessionId && matchesSessionId(s.sessionId, excludeSessionId, s.source) || minMs > 0 && s.updatedMs < minMs || !workspaceMatches(s.workspaces, workspace);
    eligible = excluded ? [] : [s];
  } else {
    eligible = catalog.filter((s) => {
      if (!includeChildren && s.isChild) return false;
      if (excludeSessionId && matchesSessionId(s.sessionId, excludeSessionId, s.source)) return false;
      if (minMs > 0 && s.updatedMs < minMs) return false;
      if (!workspaceMatches(s.workspaces, workspace)) return false;
      return true;
    });
  }
  if (safeMode === "file_history") {
    return runFileHistorySearch({
      eligible,
      query,
      sourceCoverage: coverageLabel,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      maxScanBytes,
      maxScanMs,
      workspace
    });
  }
  if (safeMode === "error_history") {
    return runErrorHistorySearch({
      eligible,
      query,
      sourceCoverage: coverageLabel,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      maxScanBytes,
      maxScanMs,
      workspace
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
        if (checkArtifactNames && s.source === "agy") {
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
  if (top.length === 0) {
    const scopeLabel = safeScope === "all" ? "transcripts, artifacts, and swarm boards" : safeScope;
    const filters = [];
    if (workspace) filters.push(`workspace~"${workspace}"`);
    if (targetSessionRef) filters.push(`sessionId="${targetSessionRef}"`);
    if (skippedInFlightCount > 0) filters.push("excluded active in-flight prompt");
    const filterSuffix = filters.length > 0 ? `; ${filters.join(", ")}` : "";
    const statusLine = incompleteNote ? `
${incompleteNote}` : `
Complete scan (${eligible.length} eligible session(s), ${coverageLabel}).
Note: text mode searches user/assistant replies, artifacts, and Swarm only; for failed commands/exit codes or tool file edits, try mode="error_history" or mode="file_history".`;
    return {
      text: `No past conversations matched "${query}" (searched ${eligible.length} session(s) [${coverageLabel}] across ${scopeLabel}${filterSuffix}).${statusLine}`,
      isError: false
    };
  }
  const lines = [
    `Search "${query}" \u2014 ${results.length} matching conversation(s) (showing top ${top.length}, scope=${safeScope}, sources=${coverageLabel}${targetSessionRef ? `, session=${targetSessionRef}` : ""}):`
  ];
  if (incompleteNote) lines.push(incompleteNote);
  for (const r of top) {
    const e = r.entry;
    const wsName = e.workspaces.length > 0 ? formatWorkspaceLabel(e.workspaces[0] ?? "") : "";
    const dispId = e.source === "agy" ? e.shortId : `${e.source}:${e.shortId}`;
    lines.push(
      `
### ${dispId} \u2014 ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`
    );
    lines.push(`ID: ${e.source === "agy" ? e.sessionId : e.canonicalId}`);
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
var SOURCE_ENUM = ["agy", "codex", "claude", "all"];
var TOOL_DEFINITIONS = [
  {
    name: "list_sessions",
    description: "List recent local conversations (read-only catalog, newest first).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy)." },
        workspace: { type: "string", description: "Workspace filter." },
        query: { type: "string", description: "Filter title, ID, workspace, prompt." },
        includeChildren: { type: "boolean", description: "Include child workers." },
        excludeSessionId: { type: "string", description: "ID/prefix list (e.g. agy:<id>)." },
        sinceHours: { type: "number", description: "Hours lookback." },
        minSteps: { type: "integer", description: "Min steps (e.g. 5)." },
        limit: { type: "integer", description: "Max rows (1..50)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." }
      }
    }
  },
  {
    name: "search_sessions",
    description: "Search past conversations (text, file_history, or error_history). Text searches replies/artifacts/Swarm (+Codex/Claude); for failed commands, test failures, or exit codes use mode='error_history' even when querying a filename.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords/phrase, regex, file path, or error text." },
        mode: {
          type: "string",
          enum: ["text", "file_history", "error_history"],
          description: "text (default: replies/artifacts/swarm), file_history (file edit vs read history, agy), or error_history (failed commands, test failures, or exit codes, agy \u2014 use error_history even when querying a filename)."
        },
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy; all=agy+codex+claude)." },
        scope: { type: "string", enum: ["all", "user", "assistant", "artifacts", "swarm"], description: "Text scope." },
        regex: { type: "boolean", description: "Regex in text mode." },
        sessionId: { type: "string", description: "Single session ID/prefix (or codex:<id>)." },
        workspace: { type: "string", description: "Workspace filter." },
        includeChildren: { type: "boolean", description: "Include child workers." },
        excludeSessionId: { type: "string", description: "ID/prefix list (e.g. agy:<id>)." },
        sinceDays: { type: "number", description: "Days lookback." },
        maxSessions: { type: "integer", description: "Max sessions (1..25)." },
        maxSnippetsPerSession: { type: "integer", description: "Excerpts/session (1..8)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." }
      },
      required: ["query"]
    }
  },
  {
    name: "read_session",
    description: "Read a past session by ID/prefix (digest, turns+charOffset, artifacts, swarm).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "ID, prefix (>=4), or source:id." },
        source: { type: "string", enum: SOURCE_ENUM, description: "Source (default agy)." },
        mode: { type: "string", enum: ["digest", "turns", "artifacts", "swarm"], description: "View mode." },
        startStep: { type: "integer", description: "turns: start step." },
        endStep: { type: "integer", description: "turns: end step." },
        tailTurns: { type: "integer", description: "turns: last N (1..40)." },
        charOffset: { type: "integer", description: "turns: >8.2KB offset." },
        includeTools: { type: "boolean", description: "turns: tool counts." },
        includeThinking: { type: "boolean", description: "turns: thinking." },
        artifactName: { type: "string", description: "artifacts: filename." },
        startLine: { type: "integer", description: "artifacts: start line." },
        endLine: { type: "integer", description: "artifacts: end line." },
        tailMessages: { type: "integer", description: "swarm: last N (1..100)." },
        startSeq: { type: "integer", description: "swarm: start #seq." },
        endSeq: { type: "integer", description: "swarm: end #seq." },
        query: { type: "string", description: "swarm: agent/text filter." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "save_note",
    description: "Save, update, or delete an editable Markdown note (topics/<id>.md + MEMORY.md index). Returns Revision; expectedRevision rejects stale writes/deletes without overwriting. Never store secrets.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short descriptive title." },
        content: { type: "string", description: "Markdown note body." },
        workspace: { type: "string", description: "Optional workspace path (omit to preserve on update, or global on create)." },
        tags: { type: "array", items: { type: "string" }, description: "Tags for recall." },
        sessionId: { type: "string", description: "Optional source session ID." },
        id: { type: "string", description: "Existing note ID to update (ASCII alnum/_/-)." },
        expectedRevision: { type: "string", description: "Revision hash from save/recall for safe CAS update/delete." },
        deleteId: { type: "string", description: "Delete note by ID." }
      }
    }
  },
  {
    name: "recall_notes",
    description: "Recall saved Markdown notes (returns file Path and Revision for direct read_file or CAS updates).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Multi-word/quoted filter on ID, topic, content, tags, workspace." },
        workspace: { type: "string", description: "Workspace filter (keeps global/parent notes)." },
        tag: { type: "string", description: "Exact tag filter." },
        limit: { type: "integer", description: "Max notes (1..30, default 15)." },
        maxChars: { type: "integer", description: "Char cap (200..8200)." }
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
        source: asString(args.source) || "agy",
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
        mode: asString(args.mode) || "text",
        source: asString(args.source) || "agy",
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
        source: asString(args.source) || "agy",
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
    case "save_note": {
      const hasWs = Object.prototype.hasOwnProperty.call(args, "workspace") && args.workspace !== void 0;
      const hasTags = Object.prototype.hasOwnProperty.call(args, "tags") && args.tags !== void 0;
      return saveNoteResult({
        dataDir,
        id: asString(args.id),
        deleteId: asString(args.deleteId),
        topic: asString(args.topic),
        content: asString(args.content),
        workspace: hasWs ? asString(args.workspace) : void 0,
        tags: hasTags ? Array.isArray(args.tags) ? args.tags : typeof args.tags === "string" ? args.tags : [] : void 0,
        sessionId: asString(args.sessionId),
        expectedRevision: asString(args.expectedRevision)
      });
    }
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
  version: "0.3.0"
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
        source: flagString(flags, "source") || "agy",
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
        mode: flagString(flags, "mode") || "text",
        source: flagString(flags, "source") || "agy",
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
        source: flagString(flags, "source") || "agy",
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
      "  node dist/mcp-server.mjs --cli list [--source agy|codex|claude|all] [--workspace <dir>] [--min-steps 5] [--exclude <id>] [--limit 15] [query]",
      "  node dist/mcp-server.mjs --cli search [--mode text|file_history|error_history] [--source agy|codex|claude|all] [--scope all|user|assistant|artifacts|swarm] [--session <id>] [--exclude <id>] [--workspace <dir>] <query>",
      "  node dist/mcp-server.mjs --cli read <sessionId> [--source agy|codex|claude|all] [--mode digest|turns|artifacts|swarm] [--tail 20] [--start-seq N] [--end-seq N] [--query <q>] [--char-offset N]",
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
