import { loadBoardEntries } from "./board.js";
import {
  formatScopeKey,
  inferDataDirFromTranscriptPath,
  resolveBoardsHome,
  scopeKeysEqual,
} from "./scope.js";
import {
  formatRelativeTime,
  loadMultiClientCatalog,
  matchesSessionId,
  resolveConversationContext,
} from "./store.js";
import type { BoardEntry, ScopeKey } from "./types.js";

export const INLINE_BOARD_BYTE_CAP = 1536;
export const INDEX_BOARD_BYTE_CAP = 1536;
const RECENT_SIBLING_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface SessionStartPayload {
  conversationId?: string;
  conversation_id?: string;
  sessionId?: string;
  session_id?: string;
  transcriptPath?: string;
  transcript_path?: string;
  cwd?: string;
  workspacePaths?: string[];
  workspace_paths?: string[];
  workspaceRoots?: string[];
  workspace_roots?: string[];
}

export interface SnapshotOptions {
  overrideDataDir?: string;
  boardsHome?: string;
  includeSiblingHint?: boolean;
  now?: number;
}

function collectWorkspacePaths(payload: SessionStartPayload): string[] {
  const out: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === "string" && val.trim() && !out.includes(val.trim())) {
      out.push(val.trim());
    }
  };
  for (const list of [
    payload.workspacePaths,
    payload.workspace_paths,
    payload.workspaceRoots,
    payload.workspace_roots,
  ]) {
    if (Array.isArray(list)) {
      for (const item of list) add(item);
    }
  }
  if (out.length === 0) add(payload.cwd);
  return out;
}

function renderInlineBoardSection(entries: BoardEntry[], now: number): string {
  const blocks: string[] = [`Project board (${entries.length} active, inline):`];
  for (const e of entries) {
    const scopeTag = e.scope.kind === "global" ? " [global]" : "";
    const titleTag = e.title && e.title !== e.key ? ` — ${e.title}` : "";
    const srcTag = e.source?.conversationId
      ? ` · from ${e.source.conversationId.slice(0, 8)}${e.source.step !== undefined ? `#${e.source.step}` : ""}`
      : "";
    blocks.push(
      `## ${e.key}${scopeTag}${titleTag} (rev=${e.revision} · ${formatRelativeTime(e.updatedAt, now)}${srcTag})\n${e.body}`,
    );
  }
  return blocks.join("\n");
}

function renderKeyIndexSection(entries: BoardEntry[], fullBytes: number, now: number): string {
  const header = `Project board (${entries.length} active, ${fullBytes} B > ${INLINE_BOARD_BYTE_CAP} B cap; call board_read for full entries):`;
  const lines: string[] = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  let shown = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i]!;
    const scopeTag = e.scope.kind === "global" ? " [global]" : "";
    const titleTag = e.title && e.title !== e.key ? ` — ${e.title}` : "";
    const srcTag = e.source?.conversationId
      ? ` · from ${e.source.conversationId.slice(0, 8)}${e.source.step !== undefined ? `#${e.source.step}` : ""}`
      : "";
    const line = `- ${e.key}${scopeTag}${titleTag} (${formatRelativeTime(e.updatedAt, now)} · rev=${e.revision}${srcTag})`;
    const remainingAfter = entries.length - (i + 1);
    const footerReserve = remainingAfter > 0 ? Buffer.byteLength(`\n(+${remainingAfter} more keys; call board_read)`, "utf8") : 0;
    const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
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

export function renderBoardSnapshotSection(
  scope: ScopeKey,
  boardsHome = resolveBoardsHome(),
  now = Date.now(),
): { text: string; mode: "empty" | "inline" | "index"; entryCount: number; renderedBytes: number } {
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
    renderedBytes: Buffer.byteLength(indexText, "utf8"),
  };
}

export function buildSessionStartSnapshot(
  payload: SessionStartPayload = {},
  opts: SnapshotOptions = {},
): string {
  const currentId = String(
    payload.conversationId || payload.conversation_id || payload.sessionId || payload.session_id || "",
  ).trim();
  const transcriptPath = String(payload.transcriptPath || payload.transcript_path || "").trim();
  const hintDataDir = inferDataDirFromTranscriptPath(transcriptPath);
  const workspaces = collectWorkspacePaths(payload);
  const now = opts.now ?? Date.now();
  const boardsHome = resolveBoardsHome(opts.boardsHome);
  const includeSiblingHint =
    opts.includeSiblingHint !== undefined
      ? opts.includeSiblingHint
      : process.env.AGY_MEMORY_SIBLING_HINT !== "0";

  const { entries: catalog } = loadMultiClientCatalog(opts.overrideDataDir || "");
  const ctx = resolveConversationContext({
    conversationId: currentId,
    overrideDataDir: opts.overrideDataDir || "",
    hintDataDir,
    hintWorkspaces: workspaces,
    catalog,
  });

  if (!currentId && ctx.scopeKey.kind === "unresolved") {
    return "";
  }

  const scopeLabel = formatScopeKey(ctx.scopeKey);
  const header = currentId
    ? `[agy-memory] session=${currentId.slice(0, 8)} (id=${currentId}, scope=${scopeLabel})`
    : `[agy-memory] scope=${scopeLabel}`;

  if (ctx.scopeKey.kind === "unresolved") {
    return header;
  }

  const lines: string[] = [header];
  const boardSection = renderBoardSnapshotSection(ctx.scopeKey, boardsHome, now);
  if (boardSection.text) {
    lines.push(boardSection.text);
  }

  if (includeSiblingHint) {
    const recentCutoff = now - RECENT_SIBLING_WINDOW_MS;
    const siblingIds = new Set<string>();
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
        `Activity: ${siblingIds.size} other active or recent session(s) in this scope (call search_sessions with conversationId="${currentId}" if prior context is needed).`,
      );
    }
  }

  return lines.join("\n");
}
