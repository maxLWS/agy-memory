import { loadNotes } from "./notes.js";
import {
  formatRelativeTime,
  formatWorkspaceLabel,
  isTempPath,
  listSessionArtifactFiles,
  loadSessionCatalog,
  matchesSessionId,
  noteWorkspaceMatches,
  readLastUserPromptSnippet,
  resolveDataDir,
  safeSliceChars,
  truncateUtf8,
  workspaceMatches,
} from "./store.js";
import type { SessionEntry } from "./types.js";

export interface SessionStartPayload {
  conversationId?: string;
  conversation_id?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  workspacePaths?: string[];
  workspace_paths?: string[];
  workspaceRoots?: string[];
  workspace_roots?: string[];
}

function firstNonEmptyString(values: unknown): string {
  if (!Array.isArray(values)) return "";
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

function isTmpPrimaryWorkspace(workspaces: string[]): boolean {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return false;
  return isTempPath(workspaces[0] ?? "");
}

export function buildSessionStartSnapshot(
  payload: SessionStartPayload = {},
  dataDir = resolveDataDir(),
): string {
  const currentId = String(
    payload?.conversationId || payload?.conversation_id || payload?.sessionId || payload?.session_id || "",
  ).trim();
  const primaryWs =
    (typeof payload?.cwd === "string" && payload.cwd.trim()) ||
    firstNonEmptyString(payload?.workspacePaths) ||
    firstNonEmptyString(payload?.workspace_paths) ||
    firstNonEmptyString(payload?.workspaceRoots) ||
    firstNonEmptyString(payload?.workspace_roots) ||
    "";
  const isCurrentTmp = isTempPath(primaryWs);
  const now = Date.now();

  const catalog = loadSessionCatalog(dataDir);
  const eligible = catalog.filter((s) => {
    if (s.isChild) return false;
    if (currentId && matchesSessionId(s.sessionId, currentId)) return false;
    if (primaryWs && !workspaceMatches(s.workspaces, primaryWs)) return false;
    return s.hasTranscript || Boolean(s.title);
  });

  // Prioritize substantive sessions over tiny untitled probes or temp-dir sessions
  const substantive: SessionEntry[] = [];
  const minor: SessionEntry[] = [];
  for (const s of eligible) {
    const tmpLeak = !isCurrentTmp && isTmpPrimaryWorkspace(s.workspaces);
    const hasSubstance = !tmpLeak && Boolean(s.title) && (s.stepCount >= 5 || s.hasSwarm);
    if (hasSubstance) {
      substantive.push(s);
    } else if (!tmpLeak) {
      minor.push(s);
    }
  }
  const recent = [...substantive, ...minor].slice(0, 5);

  const notes = loadNotes(dataDir)
    .filter((n) => noteWorkspaceMatches(n.workspace, primaryWs))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 5);

  if (recent.length === 0 && notes.length === 0 && !currentId) {
    return "";
  }

  const lines = ["[agy-memory] Local cross-conversation context (read-only snapshot):"];
  if (currentId) {
    const shortCur = currentId.slice(0, 8);
    lines.push(`Current session: ${shortCur} (pass excludeSessionId="${shortCur}" when searching past sessions)`);
  }

  if (recent.length > 0) {
    const wsLabel = primaryWs ? formatWorkspaceLabel(primaryWs) : "";
    const wsTag = wsLabel ? ` in ${wsLabel}` : "";
    lines.push(`Recent sessions${wsTag}:`);
    for (const s of recent) {
      const snippet = s.hasTranscript
        ? readLastUserPromptSnippet(s.paths.transcriptPath, 88, { preferSubstantive: true })
        : "";
      const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
      const flags: string[] = [];
      if (s.hasSwarm) flags.push("swarm");
      if (artifacts.length > 0) flags.push(`${artifacts.length}art`);
      const badge = flags.length > 0 ? ` [${flags.join(",")}]` : "";
      const stepPart = s.stepCount > 0 ? `, ${s.stepCount} steps` : "";
      const title = s.title || "(untitled)";
      lines.push(
        `- ${s.shortId} (${formatRelativeTime(s.updatedMs, now)}${stepPart})${badge} ${title}${snippet ? ` — "${snippet}"` : ""}`,
      );
    }
  }

  if (notes.length > 0) {
    lines.push("Pinned notes:");
    for (const n of notes) {
      const text = String(n.content || "").replace(/\s+/g, " ").trim();
      const clip = text.length > 180 ? `${safeSliceChars(text, 179)}…` : text;
      const tagPart = Array.isArray(n.tags) && n.tags.length > 0 ? ` [${n.tags.join(", ")}]` : "";
      lines.push(`- [${n.id}] ${n.topic}${tagPart}: ${clip}`);
    }
  }

  lines.push(
    'Use mcp_agy-memory_memory_search_sessions / mcp_agy-memory_memory_read_session(mode="digest") when past session details are needed.',
  );
  return truncateUtf8(lines.join("\n"), 1650, 1800);
}
