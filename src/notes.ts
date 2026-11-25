import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clampMaxChars,
  formatRelativeTime,
  formatShortDate,
  formatWorkspaceLabel,
  noteWorkspaceMatches,
  parseQueryTokens,
  resolveDataDir,
  safeSliceChars,
  truncateUtf8,
} from "./store.js";
import type { NoteItem, NoteLoadResult, ToolResult } from "./types.js";

const INDEX_START = "<!-- agy-memory:index:start -->";
const INDEX_END = "<!-- agy-memory:index:end -->";
const MAX_INDEX_LINES = 150;
const FRONTMATTER_SCHEMA_VERSION = 1;
const VALID_NOTE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const LOCK_TIMEOUT_MS = 1500;
const STALE_LOCK_MS = 10_000;

export interface SaveNoteOptions {
  dataDir?: string;
  id?: string;
  deleteId?: string;
  topic?: string;
  content?: string;
  workspace?: string;
  tags?: string[] | string;
  sessionId?: string;
  expectedRevision?: string;
}

export interface RecallNotesOptions {
  dataDir?: string;
  query?: string;
  workspace?: string;
  tag?: string;
  limit?: number;
  maxChars?: number;
}

export interface LoadNotesOptions {
  readOnly?: boolean;
}

export function getNotesPath(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}

export function getMemoryDir(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "plugin_data", "agy-memory", "memory");
}

export function getMemoryIndexPath(dataDir = resolveDataDir()): string {
  return path.join(getMemoryDir(dataDir), "MEMORY.md");
}

export function getTopicsDir(dataDir = resolveDataDir()): string {
  return path.join(getMemoryDir(dataDir), "topics");
}

export function isValidNoteId(id: string): boolean {
  return VALID_NOTE_ID_RE.test(id);
}

function getTopicFilePath(dataDir: string, validatedId: string): string {
  if (!isValidNoteId(validatedId)) {
    throw new Error(`Invalid note ID "${validatedId}". Use 1-64 ASCII letters, digits, '_' or '-' starting with a letter/digit.`);
  }
  return path.join(getTopicsDir(dataDir), `${validatedId}.md`);
}

function computeRevision(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

function writeTextAtomic(filePath: string, payload: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, ms);
}

/**
 * Serializes note writers across concurrent MCP processes using an atomic lockfile.
 */
function withNotesLock<T>(dataDir: string, fn: () => T): T {
  const memDir = getMemoryDir(dataDir);
  fs.mkdirSync(memDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(memDir, ".notes.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
      fs.closeSync(fd);
      acquired = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lockPath);
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
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore unlock error
    }
  }
}

function normalizeTagsInput(rawTags: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(rawTags)) {
    list = rawTags;
  } else if (typeof rawTags === "string" && rawTags.trim()) {
    list = rawTags.split(",");
  }
  return [...new Set(list.map((t) => String(t ?? "").trim().toLowerCase()).filter(Boolean))];
}

function serializeTopicMarkdown(note: NoteItem): string {
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
    "---",
  ].join("\n");
  return `${fm}\n\n${note.content.replace(/^\n+/, "").trimEnd()}\n`;
}

function parseFrontmatterValue(rawVal: string): { value: unknown; error: string | null } {
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

function parseTopicMarkdown(raw: string, filePath: string): { note: NoteItem | null; error: string | null } {
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
  // Preserve meaningful leading Markdown indentation (strip only leading separator blank lines and trailing whitespace)
  const rawBody = endIdx >= 0 ? normalized.slice(endIdx + 5) : "";
  const body = rawBody.replace(/^\n+/, "").trimEnd();
  const meta: Record<string, unknown> = {};

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
  if (meta.schema !== undefined && (!Number.isInteger(schemaVer) || schemaVer !== FRONTMATTER_SCHEMA_VERSION)) {
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
    stMtime = Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    // Ignore
  }

  const note: NoteItem = {
    id,
    topic,
    content: body,
    workspace: String(meta.workspace || "").trim(),
    tags: normalizeTagsInput(meta.tags),
    sessionId: String(meta.sessionId || "").trim(),
    createdAt: Number(meta.createdAt) || stMtime,
    updatedAt: Number(meta.updatedAt) || stMtime,
    filePath,
    revision: computeRevision(raw),
  };
  return { note, error: null };
}

function rebuildMemoryIndexFile(dataDir: string, notes: NoteItem[]): void {
  const indexPath = getMemoryIndexPath(dataDir);
  const sorted = [...notes].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const indexRows: string[] = [
    INDEX_START,
    `<!-- Auto-maintained index (${sorted.length} notes; topics/*.md files are authoritative) -->`,
  ];
  const maxRows = Math.max(10, MAX_INDEX_LINES - 12);
  for (const n of sorted.slice(0, maxRows)) {
    const ws = n.workspace ? ` · ${formatWorkspaceLabel(n.workspace)}` : "";
    const tags = n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const preview = n.content.replace(/\s+/g, " ").trim();
    const shortPrev = preview.length > 100 ? `${safeSliceChars(preview, 99)}…` : preview;
    const relName = n.filePath ? path.basename(n.filePath) : `${n.id}.md`;
    indexRows.push(`- **[${n.id}] ${n.topic}**${tags}${ws} → \`topics/${relName}\` — ${shortPrev}`);
  }
  if (sorted.length > maxRows) {
    indexRows.push(`- … (${sorted.length - maxRows} additional note(s) in \`topics/\`; use \`recall_notes\` to query all)`);
  }
  indexRows.push(INDEX_END);
  const managedBlock = indexRows.join("\n");

  let finalDoc = `# agy-memory Index\n\nAdd personal notes above or below the managed markers; topic files in \`topics/\` are authoritative.\n\n${managedBlock}\n`;
  if (fs.existsSync(indexPath)) {
    try {
      const existing = fs.readFileSync(indexPath, "utf8").replace(/\r\n/g, "\n");
      const sIdx = existing.indexOf(INDEX_START);
      const eIdx = existing.indexOf(INDEX_END);
      if (sIdx >= 0 && eIdx > sIdx) {
        finalDoc = `${existing.slice(0, sIdx)}${managedBlock}${existing.slice(eIdx + INDEX_END.length)}`;
      } else if (existing.trim()) {
        finalDoc = `${existing.trimEnd()}\n\n${managedBlock}\n`;
      }
    } catch {
      // Fall back to fresh index
    }
  }
  writeTextAtomic(indexPath, finalDoc);
}

function sanitizeLegacyNoteId(rawId: string): string {
  const trimmed = String(rawId || "").trim();
  if (isValidNoteId(trimmed)) return trimmed;
  const hash = crypto.createHash("sha256").update(trimmed || crypto.randomBytes(8).toString("hex")).digest("hex").slice(0, 8);
  const prefix = trimmed.replace(/[^a-zA-Z0-9_-]/g, "").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 48);
  return prefix ? `${prefix}-${hash}` : `note-${hash}`;
}

function readTopicsFromDisk(dataDir: string, warnings: string[]): NoteItem[] {
  const topicsDir = getTopicsDir(dataDir);
  if (!fs.existsSync(topicsDir)) return [];

  const notes: NoteItem[] = [];
  const seenIds = new Map<string, string>();
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(topicsDir)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .sort();
  } catch {
    return [];
  }

  for (const name of entries) {
    const filePath = path.join(topicsDir, name);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
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

function loadLegacyJsonNotesReadOnly(dataDir: string): { notes: NoteItem[]; warnings: string[] } {
  const filePath = getNotesPath(dataDir);
  const warnings: string[] = [];
  if (!fs.existsSync(filePath)) return { notes: [], warnings };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { notes?: unknown };
    const notes = Array.isArray(parsed?.notes) ? (parsed.notes as NoteItem[]) : [];
    return { notes, warnings };
  } catch {
    warnings.push(`Malformed legacy notes file preserved untouched: ${filePath}`);
    return { notes: [], warnings };
  }
}

function maybeMigrateLegacyNotesJson(dataDir: string, warnings: string[]): void {
  const legacyPath = getNotesPath(dataDir);
  if (!fs.existsSync(legacyPath)) return;
  const markerPath = path.join(getMemoryDir(dataDir), ".migrated_v1_json");
  if (fs.existsSync(markerPath)) return;

  withNotesLock(dataDir, () => {
    if (fs.existsSync(markerPath)) return;
    let legacyNotes: NoteItem[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as { notes?: unknown };
      if (!Array.isArray(parsed?.notes)) {
        warnings.push(`Legacy ${legacyPath} has invalid structure; preserved untouched.`);
        return;
      }
      legacyNotes = parsed.notes as NoteItem[];
    } catch {
      warnings.push(`Legacy ${legacyPath} could not be parsed as JSON; preserved untouched.`);
      return;
    }

    const topicsDir = getTopicsDir(dataDir);
    fs.mkdirSync(topicsDir, { recursive: true, mode: 0o700 });

    let allVerified = true;
    let migratedAny = false;
    for (let i = 0; i < legacyNotes.length; i += 1) {
      const raw = legacyNotes[i]!;
      const topic = String(raw.topic || "").trim();
      const content = String(raw.content || "").replace(/^\n+/, "").trimEnd();
      if (!topic || !content.trim()) {
        allVerified = false;
        warnings.push(`Legacy note #${i + 1} has empty topic/content; legacy notes.json retained for inspection.`);
        continue;
      }
      const id = sanitizeLegacyNoteId(String(raw.id || ""));
      const dst = getTopicFilePath(dataDir, id);

      if (fs.existsSync(dst)) {
        // Verify existing file matches; if it differs or is malformed, never overwrite or claim migration complete
        try {
          const existingParsed = parseTopicMarkdown(fs.readFileSync(dst, "utf8"), dst);
          if (
            existingParsed.note &&
            existingParsed.note.id === id &&
            existingParsed.note.topic === topic &&
            existingParsed.note.content === content
          ) {
            continue;
          }
        } catch {
          // Fall through to conflict warning
        }
        allVerified = false;
        warnings.push(`Migration collision for legacy note "${id}" (${dst} already exists with different content); preserved untouched.`);
        continue;
      }

      const normalized: NoteItem = {
        id,
        topic,
        content,
        workspace: String(raw.workspace || "").trim(),
        tags: normalizeTagsInput(raw.tags),
        sessionId: String(raw.sessionId || "").trim(),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
      writeTextAtomic(dst, serializeTopicMarkdown(normalized));
      const verify = parseTopicMarkdown(fs.readFileSync(dst, "utf8"), dst);
      if (
        !verify.note ||
        verify.note.id !== normalized.id ||
        verify.note.topic !== normalized.topic ||
        verify.note.content !== normalized.content
      ) {
        allVerified = false;
        warnings.push(`Migration verification failed for note ${id}; legacy notes.json retained.`);
      } else {
        migratedAny = true;
      }
    }

    if (migratedAny || fs.existsSync(topicsDir)) {
      const freshWarnings: string[] = [];
      const currentNotes = readTopicsFromDisk(dataDir, freshWarnings);
      if (currentNotes.length > 0 && !fs.existsSync(getMemoryIndexPath(dataDir))) {
        rebuildMemoryIndexFile(dataDir, currentNotes);
      }
    }
    if (allVerified) {
      writeTextAtomic(markerPath, `migrated_at=${new Date().toISOString()}\ncount=${legacyNotes.length}\n`);
    }
  });
}

export function loadNotesWithDiagnostics(
  dataDir = resolveDataDir(),
  opts: LoadNotesOptions = {},
): NoteLoadResult {
  const warnings: string[] = [];
  const topicsDir = getTopicsDir(dataDir);
  const memoryIndexPath = getMemoryIndexPath(dataDir);

  if (opts.readOnly) {
    // Strictly read-only path (used by SessionStart hook): never writes migration files
    const topicNotes = readTopicsFromDisk(dataDir, warnings);
    if (topicNotes.length > 0 || fs.existsSync(topicsDir)) {
      return { notes: topicNotes, warnings, memoryIndexPath, topicsDir };
    }
    const legacy = loadLegacyJsonNotesReadOnly(dataDir);
    return {
      notes: legacy.notes,
      warnings: [...warnings, ...legacy.warnings],
      memoryIndexPath: getNotesPath(dataDir),
      topicsDir,
    };
  }

  maybeMigrateLegacyNotesJson(dataDir, warnings);
  const notes = readTopicsFromDisk(dataDir, warnings);
  return { notes, warnings, memoryIndexPath, topicsDir };
}

export function loadNotes(dataDir = resolveDataDir(), opts: LoadNotesOptions = {}): NoteItem[] {
  return loadNotesWithDiagnostics(dataDir, opts).notes;
}

export function saveNoteResult(opts: SaveNoteOptions = {}): ToolResult {
  const {
    dataDir = resolveDataDir(),
    id = "",
    deleteId = "",
    topic = "",
    content = "",
    workspace,
    tags,
    sessionId = "",
    expectedRevision = "",
  } = opts;

  const cleanExpectedRev = String(expectedRevision || "").trim();

  try {
    return withNotesLock(dataDir, () => {
      const warnings: string[] = [];
      maybeMigrateLegacyNotesJson(dataDir, warnings);
      const notes = readTopicsFromDisk(dataDir, warnings);
      const memoryIndexPath = getMemoryIndexPath(dataDir);

      if (deleteId) {
        const target = String(deleteId).trim();
        if (!isValidNoteId(target)) {
          return { text: `Error: Invalid deleteId "${target}".`, isError: true };
        }
        const existing = notes.find((n) => n.id === target);
        if (!existing || !existing.filePath || !fs.existsSync(existing.filePath)) {
          return { text: `Error: Note "${target}" not found.`, isError: true };
        }
        const liveRaw = fs.readFileSync(existing.filePath, "utf8");
        const liveRev = computeRevision(liveRaw);
        if (cleanExpectedRev && cleanExpectedRev !== liveRev) {
          return {
            text: `Error: Revision conflict deleting note [${target}] (expected ${cleanExpectedRev}, live ${liveRev}). Live file preserved untouched.\nPath: ${existing.filePath}\nRevision: ${liveRev}`,
            isError: true,
          };
        }
        fs.unlinkSync(existing.filePath);
        const freshAfter = readTopicsFromDisk(dataDir, []);
        rebuildMemoryIndexFile(dataDir, freshAfter);
        return {
          text: `Deleted note ${target} (${existing.filePath}). (${freshAfter.length} note(s) remaining)`,
          isError: false,
        };
      }

      const cleanTopic = String(topic || "").trim();
      const cleanContent = String(content || "").replace(/^\n+/, "").trimEnd();
      if (!cleanTopic || !cleanContent.trim()) {
        return {
          text: "Error: both `topic` and `content` are required (or pass `deleteId` to remove a note).",
          isError: true,
        };
      }

      const cleanId = String(id || "").trim();
      if (cleanId && !isValidNoteId(cleanId)) {
        return {
          text: `Error: Invalid note id "${cleanId}". Use 1-64 ASCII letters, digits, '_' or '-' starting with a letter/digit.`,
          isError: true,
        };
      }

      const hasWorkspaceArg = workspace !== undefined;
      const hasTagsArg = tags !== undefined;
      const cleanWsArg = hasWorkspaceArg ? String(workspace || "").trim() : "";
      const cleanTagsArg = hasTagsArg ? normalizeTagsInput(tags) : [];
      const now = Date.now();

      const existing = cleanId
        ? notes.find((n) => n.id === cleanId)
        : notes.find(
            (n) =>
              n.topic.toLowerCase() === cleanTopic.toLowerCase() &&
              n.workspace.toLowerCase() === cleanWsArg.toLowerCase(),
          );

      // Strict CAS: never recreate a deleted note when expectedRevision was supplied
      if (cleanExpectedRev && !existing) {
        return {
          text: `Error: Revision conflict — note "${cleanId || cleanTopic}" does not exist on disk (expected revision ${cleanExpectedRev}). Refusing to recreate.`,
          isError: true,
        };
      }

      const noteId = existing ? existing.id : cleanId || crypto.randomBytes(4).toString("hex");
      const topicPath = existing?.filePath || getTopicFilePath(dataDir, noteId);

      // Never overwrite an occupied destination on create (protects malformed or manual files skipped on load)
      if (!existing && fs.existsSync(topicPath)) {
        return {
          text: `Error: Destination file already exists for id "${noteId}" (${topicPath}). Refusing to overwrite an unreadable or untracked file.`,
          isError: true,
        };
      }

      // Strict CAS on update: reject stale writes without mutating the live file
      if (existing && fs.existsSync(topicPath)) {
        const liveRaw = fs.readFileSync(topicPath, "utf8");
        const liveRev = computeRevision(liveRaw);
        if (cleanExpectedRev && cleanExpectedRev !== liveRev) {
          return {
            text: `Error: Revision conflict updating note [${noteId}] (expected ${cleanExpectedRev}, live ${liveRev}). Live file preserved untouched; re-read before retrying.\nPath: ${topicPath}\nRevision: ${liveRev}`,
            isError: true,
          };
        }
      }

      const saved: NoteItem = existing
        ? {
            ...existing,
            topic: cleanTopic,
            content: cleanContent,
            workspace: hasWorkspaceArg ? cleanWsArg : existing.workspace,
            tags: hasTagsArg ? cleanTagsArg : existing.tags || [],
            sessionId: sessionId || existing.sessionId || "",
            updatedAt: now,
            filePath: topicPath,
          }
        : {
            id: noteId,
            topic: cleanTopic,
            content: cleanContent,
            workspace: cleanWsArg,
            tags: cleanTagsArg,
            sessionId: String(sessionId || ""),
            createdAt: now,
            updatedAt: now,
            filePath: topicPath,
          };

      const md = serializeTopicMarkdown(saved);
      saved.revision = computeRevision(md);
      writeTextAtomic(topicPath, md);

      // Reload authoritative topics directory under lock before updating MEMORY.md
      const freshNotes = readTopicsFromDisk(dataDir, []);
      rebuildMemoryIndexFile(dataDir, freshNotes);

      const verb = existing ? "Updated" : "Saved";
      const tagNote = saved.tags.length > 0 ? ` [${saved.tags.join(", ")}]` : "";
      const wsNote = saved.workspace ? ` (${saved.workspace})` : "";
      const warnNote = warnings.length > 0 ? `\nWarnings: ${warnings.join("; ")}` : "";
      return {
        text: `${verb} note [${saved.id}] "${saved.topic}"${tagNote}${wsNote}.\nPath: ${topicPath}\nRevision: ${saved.revision}\nIndex: ${memoryIndexPath}${warnNote}`,
        isError: false,
      };
    });
  } catch (err) {
    return {
      text: `Error saving note: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export function saveNoteAction(opts: SaveNoteOptions = {}): string {
  return saveNoteResult(opts).text;
}

export function recallNotesResult(opts: RecallNotesOptions = {}): ToolResult {
  const {
    dataDir = resolveDataDir(),
    query = "",
    workspace = "",
    tag = "",
    limit = 15,
    maxChars = 8200,
  } = opts;

  const { notes, warnings, memoryIndexPath } = loadNotesWithDiagnostics(dataDir);
  const warnBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";

  if (notes.length === 0) {
    return { text: `No saved cross-session notes yet.${warnBlock}`, isError: false };
  }

  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const terms = parseQueryTokens(query);
  const tagFilter = String(tag || "").trim().toLowerCase();

  const filtered = notes
    .filter((n) => {
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
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, safeLimit);

  if (filtered.length === 0) {
    return {
      text: `No saved notes matched your filter (${notes.length} total notes stored).${warnBlock}`,
      isError: false,
    };
  }

  const now = Date.now();
  const lines = [
    `Saved cross-session notes (${filtered.length} of ${notes.length}; Index: ${memoryIndexPath}):`,
  ];
  for (const n of filtered) {
    const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const wsLabel = n.workspace ? formatWorkspaceLabel(n.workspace) : "";
    const wsPart = wsLabel ? ` · ${wsLabel}` : "";
    const srcPart = n.sessionId ? ` · from ${n.sessionId.slice(0, 8)}` : "";
    lines.push(
      `\n- **[${n.id}] ${n.topic}**${tagPart} (${formatShortDate(n.updatedAt)}, ${formatRelativeTime(n.updatedAt, now)}${wsPart}${srcPart})`,
    );
    if (n.filePath) {
      const lineCount = n.content.split("\n").length;
      const revPart = n.revision ? ` · Revision: ${n.revision}` : "";
      lines.push(`  Path: ${n.filePath} (${lineCount} lines${revPart})`);
    }
    const body = n.content.length > 1200 && n.filePath ? `${safeSliceChars(n.content, 1180)}… (use read_file on Path for full note)` : n.content;
    lines.push(`  ${body}`);
  }
  if (warnBlock) lines.push(warnBlock);

  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

export function recallNotesFormatted(opts: RecallNotesOptions = {}): string {
  return recallNotesResult(opts).text;
}
