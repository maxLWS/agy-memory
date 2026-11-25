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
  truncateUtf8,
} from "./store.js";
import type { NoteItem, ToolResult } from "./types.js";

export interface SaveNoteOptions {
  dataDir?: string;
  id?: string;
  deleteId?: string;
  topic?: string;
  content?: string;
  workspace?: string;
  tags?: string[] | string;
  sessionId?: string;
}

export interface RecallNotesOptions {
  dataDir?: string;
  query?: string;
  workspace?: string;
  tag?: string;
  limit?: number;
  maxChars?: number;
}

export function getNotesPath(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "plugin_data", "agy-memory", "notes.json");
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  try {
    fs.writeFileSync(tmpPath, payload, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      // On Windows, replacing an existing file can occasionally fail if an antivirus/indexer briefly holds a handle
      fs.copyFileSync(tmpPath, filePath);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

export function loadNotes(dataDir = resolveDataDir()): NoteItem[] {
  const filePath = getNotesPath(dataDir);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { notes?: unknown };
    return Array.isArray(parsed?.notes) ? (parsed.notes as NoteItem[]) : [];
  } catch {
    return [];
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

export function saveNoteResult(opts: SaveNoteOptions = {}): ToolResult {
  const {
    dataDir = resolveDataDir(),
    id = "",
    deleteId = "",
    topic = "",
    content = "",
    workspace = "",
    tags = [],
    sessionId = "",
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
      isError: false,
    };
  }

  const cleanTopic = String(topic || "").trim();
  const cleanContent = String(content || "").trim();
  if (!cleanTopic || !cleanContent) {
    return {
      text: "Error: both `topic` and `content` are required (or pass `deleteId` to remove a note).",
      isError: true,
    };
  }

  const cleanTags = normalizeTagsInput(tags);
  const cleanWs = String(workspace || "").trim();
  const cleanId = String(id || "").trim();
  const now = Date.now();

  const existingIdx = cleanId
    ? notes.findIndex((n) => n.id === cleanId)
    : notes.findIndex(
        (n) =>
          String(n.topic || "").toLowerCase() === cleanTopic.toLowerCase() &&
          String(n.workspace || "").toLowerCase() === cleanWs.toLowerCase(),
      );

  let saved: NoteItem;
  if (existingIdx >= 0) {
    const existing = notes[existingIdx]!;
    saved = {
      ...existing,
      topic: cleanTopic,
      content: cleanContent,
      workspace: cleanWs,
      tags: cleanTags.length > 0 ? cleanTags : existing.tags || [],
      sessionId: sessionId || existing.sessionId || "",
      updatedAt: now,
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
      updatedAt: now,
    };
    notes.push(saved);
  }

  writeJsonAtomic(filePath, { version: 1, notes });
  const verb = existingIdx >= 0 ? "Updated" : "Saved";
  const tagNote = saved.tags.length > 0 ? ` [${saved.tags.join(", ")}]` : "";
  return {
    text: `${verb} note [${saved.id}] "${saved.topic}"${tagNote}${cleanWs ? ` (${cleanWs})` : ""}.`,
    isError: false,
  };
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

  const notes = loadNotes(dataDir);
  if (notes.length === 0) {
    return { text: "No saved cross-session notes yet.", isError: false };
  }

  const safeLimit = Math.max(1, Math.min(30, Number(limit) || 15));
  const safeMaxChars = clampMaxChars(maxChars, 8200);
  const terms = parseQueryTokens(query);
  const tagFilter = String(tag || "").trim().toLowerCase();

  const filtered = notes
    .filter((n) => {
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
    })
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, safeLimit);

  if (filtered.length === 0) {
    return {
      text: `No saved notes matched your filter (${notes.length} total notes stored).`,
      isError: false,
    };
  }

  const now = Date.now();
  const lines = [`Saved cross-session notes (${filtered.length} of ${notes.length}):`];
  for (const n of filtered) {
    const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
    const wsLabel = n.workspace ? formatWorkspaceLabel(n.workspace) : "";
    const wsPart = wsLabel ? ` · ${wsLabel}` : "";
    const srcPart = n.sessionId ? ` · from ${n.sessionId.slice(0, 8)}` : "";
    lines.push(
      `\n- **[${n.id}] ${n.topic}**${tagPart} (${formatShortDate(n.updatedAt)}, ${formatRelativeTime(n.updatedAt, now)}${wsPart}${srcPart})`,
    );
    lines.push(`  ${n.content}`);
  }

  return { text: truncateUtf8(lines.join("\n"), safeMaxChars), isError: false };
}

export function recallNotesFormatted(opts: RecallNotesOptions = {}): string {
  return recallNotesResult(opts).text;
}
