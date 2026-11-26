import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { formatScopeKey, parseExplicitScopeKey, scopeKeysEqual } from "./scope.js";
import {
  clampMaxChars,
  formatRelativeTime,
  formatShortDate,
  formatWorkspaceLabel,
  getSearchableSessionDoc,
  isSessionDocCached,
  listSessionArtifactFiles,
  loadMultiClientCatalog,
  matchesSessionId,
  normalizeFsPath,
  parseQueryTokens,
  resolveConversationContext,
  resolveSessionEntry,
  safeSliceChars,
  truncateUtf8,
  workspaceMatches,
} from "./store.js";
import { checkScanBudget, createScanBudget } from "./stream.js";
import { runErrorHistorySearch, runFileHistorySearch } from "./trace.js";
import type { ScanBudget, ScopeKey, SessionEntry, ToolResult } from "./types.js";

const RG_CANDIDATES =
  process.platform === "win32"
    ? ["rg", "rg.exe"]
    : ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"];
const VALID_SCOPES = new Set(["all", "user", "assistant", "artifacts", "swarm"]);
const VALID_SEARCH_MODES = new Set(["text", "file_history", "error_history"]);
const IN_FLIGHT_WINDOW_MS = 180 * 1000;
const JSON_ESCAPED_CHAR_RE = /["\\<>&\n\r\t]/;
const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;

interface ParsedQuery {
  terms: string[];
  regex: RegExp | null;
  error: string | null;
}

interface MatchResult {
  matchedAny: boolean;
  matchedAll: boolean;
  hitTerms: Set<string>;
}

interface SnippetCandidate {
  score: number;
  stepIndex: number;
  role: string;
  sourceKind: "user" | "assistant" | "artifact" | "swarm";
  date: string;
  hitTerms: Set<string>;
  excerpt: string;
  artifactPath?: string;
  artifactLines?: number;
}

interface SessionSearchHit {
  entry: SessionEntry;
  score: number;
  totalHits: number;
  titleMatched: boolean;
  snippets: SnippetCandidate[];
}

function parseSearchQuery(rawQuery: string, isRegex: boolean): ParsedQuery {
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
        error: `Error: Invalid regular expression "${text}": ${msg}`,
      };
    }
  }
  const terms = parseQueryTokens(text);
  return { terms, regex: null, error: null };
}

function buildCenteredSnippet(text: string, terms: string[], regex: RegExp | null, radius = 95): string {
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
    return clean.length > radius * 2 ? `${safeSliceChars(clean, radius * 2 - 1)}…` : clean;
  }
  const start = Math.max(0, hitIdx - radius);
  const end = Math.min(clean.length, hitIdx + radius + 35);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  let slice = clean.slice(start, end);
  if (slice.length > 0) {
    const firstCode = slice.charCodeAt(0);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff) {
      slice = slice.slice(1);
    }
  }
  slice = safeSliceChars(slice, slice.length);
  return `${prefix}${slice}${suffix}`;
}

function rankSeedTerms(terms: string[]): string[] {
  return [...terms].sort((a, b) => {
    const scoreOf = (term: string): number => {
      const cjkMatches = term.match(CJK_CHAR_RE);
      const cjkCount = cjkMatches ? cjkMatches.length : 0;
      const nonCjkLen = term.length - cjkCount;
      return cjkCount * 3.5 + nonCjkLen;
    };
    return scoreOf(b) - scoreOf(a);
  });
}

function collectEligibleRgFiles(
  entries: SessionEntry[],
  scope: string,
): { files: string[]; fileToSession: Map<string, string> } {
  const wantTranscript = scope === "all" || scope === "user" || scope === "assistant";
  const wantArtifacts = scope === "all" || scope === "artifacts";
  const wantSwarm = scope === "all" || scope === "swarm";
  const files: string[] = [];
  const fileToSession = new Map<string, string>();

  const registerFile = (filePath: string, canonicalId: string): void => {
    files.push(filePath);
    fileToSession.set(normalizeFsPath(filePath), canonicalId);
  };

  for (const entry of entries) {
    if (wantTranscript && entry.hasTranscript) {
      registerFile(entry.paths.transcriptPath, entry.canonicalId);
      if (entry.paths.transcriptFullPath && fs.existsSync(entry.paths.transcriptFullPath)) {
        registerFile(entry.paths.transcriptFullPath, entry.canonicalId);
      }
    }
    if (wantArtifacts) {
      const arts = listSessionArtifactFiles(entry.paths.brainDir, { includeMeta: false });
      for (const art of arts) {
        registerFile(art.path, entry.canonicalId);
      }
    }
    if (wantSwarm && entry.hasSwarm && entry.paths.swarmBoardPath && fs.existsSync(entry.paths.swarmBoardPath)) {
      registerFile(entry.paths.swarmBoardPath, entry.canonicalId);
    }
  }
  return { files, fileToSession };
}

function findMatchingSessionsWithRg(
  entries: SessionEntry[],
  pattern: string,
  isRegex: boolean,
  scope: string,
): Set<string> | null {
  const { files, fileToSession } = collectEligibleRgFiles(entries, scope);
  if (files.length === 0) return new Set();

  const CHUNK_SIZE = process.platform === "win32" ? 120 : 400;
  const matchedSessions = new Set<string>();

  for (let offset = 0; offset < files.length; offset += CHUNK_SIZE) {
    const slice = files.slice(offset, offset + CHUNK_SIZE);
    const args = ["--files-with-matches", "--ignore-case", "--no-messages", "--follow"];
    if (!isRegex) args.push("--fixed-strings");
    args.push("--", pattern, ...slice);

    let chunkDone = false;
    for (const rgBin of RG_CANDIDATES) {
      try {
        const stdout = execFileSync(rgBin, args, {
          encoding: "utf8",
          timeout: 4000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
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
        const status = (err as { status?: unknown })?.status;
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

function matchLowerOrRegex(
  lowText: string,
  origText: string,
  terms: string[],
  regex: RegExp | null,
): MatchResult {
  if (!origText) return { matchedAny: false, matchedAll: false, hitTerms: new Set() };
  if (regex) {
    const ok = regex.test(origText);
    return { matchedAny: ok, matchedAll: ok, hitTerms: ok ? new Set(["__re__"]) : new Set() };
  }
  const hitTerms = new Set<string>();
  for (const term of terms) {
    if (lowText.includes(term)) hitTerms.add(term);
  }
  return {
    matchedAny: hitTerms.size > 0,
    matchedAll: hitTerms.size === terms.length,
    hitTerms,
  };
}

function selectDiverseSnippets(
  candidates: SnippetCandidate[],
  terms: string[],
  maxSnippets: number,
): SnippetCandidate[] {
  if (candidates.length <= maxSnippets) {
    return [...candidates].sort((a, b) => b.score - a.score || b.stepIndex - a.stepIndex);
  }

  const remaining = [...candidates];
  const selected: SnippetCandidate[] = [];
  const coveredTerms = new Set<string>();

  while (selected.length < maxSnippets && remaining.length > 0) {
    let bestIdx = 0;
    let bestEffective = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i]!;
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
          (picked) =>
            picked.role === cand.role &&
            picked.stepIndex >= 0 &&
            cand.stepIndex >= 0 &&
            Math.abs(picked.stepIndex - cand.stepIndex) <= 12,
        );
        if (nearExisting) effective -= 2.0;
        const distinctSource = selected.every((picked) => picked.sourceKind !== cand.sourceKind);
        if (distinctSource) effective += 1.2;
      }

      if (
        effective > bestEffective ||
        (effective === bestEffective && cand.stepIndex > remaining[bestIdx]!.stepIndex)
      ) {
        bestEffective = effective;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]!;
    selected.push(chosen);
    for (const t of chosen.hitTerms) coveredTerms.add(t);
  }

  return selected;
}

function scanSessionDoc(
  entry: SessionEntry,
  {
    scope,
    terms,
    regex,
    maxSnippets,
    now,
    skipInFlightSelfPrompt,
    budget,
  }: {
    scope: string;
    terms: string[];
    regex: RegExp | null;
    maxSnippets: number;
    now: number;
    skipInFlightSelfPrompt: boolean;
    budget?: ScanBudget;
  },
): { hit: SessionSearchHit | null; skippedInFlight: boolean } {
  const sessionTermsFound = new Set<string>();
  const candidates: SnippetCandidate[] = [];
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
  const isRecentlyActive =
    doc.latestTranscriptMtimeMs > 0 && now - doc.latestTranscriptMtimeMs < IN_FLIGHT_WINDOW_MS;

  const wantTranscript = scope === "all" || scope === "user" || scope === "assistant";
  const wantArtifacts = scope === "all" || scope === "artifacts";
  const wantSwarm = scope === "all" || scope === "swarm";

  if (wantTranscript && doc.messages.length > 0) {
    for (let i = doc.messages.length - 1; i >= 0; i -= 1) {
      const msg = doc.messages[i]!;
      if (scope === "user" && msg.role !== "user") continue;
      if (scope === "assistant" && msg.role !== "assistant") continue;

      if (
        skipInFlightSelfPrompt &&
        isRecentlyActive &&
        msg.role === "user" &&
        msg.stepIndex === doc.inFlightUserStepIndex
      ) {
        skippedInFlight = true;
        continue;
      }

      const check = matchLowerOrRegex(msg.lowText, msg.text, terms, regex);
      if (!check.matchedAny) continue;
      for (const t of check.hitTerms) sessionTermsFound.add(t);

      const baseScore =
        (check.matchedAll ? 6 : 1.5 * check.hitTerms.size) + (msg.role === "user" ? 1 : 0.5);
      candidates.push({
        score: baseScore,
        stepIndex: msg.stepIndex,
        role: msg.role,
        sourceKind: msg.role,
        date: msg.date,
        hitTerms: check.hitTerms,
        excerpt: buildCenteredSnippet(msg.text, terms, regex),
      });
    }
  }

  if (wantArtifacts && doc.artifacts.length > 0) {
    for (const art of doc.artifacts) {
      const check = matchLowerOrRegex(art.lowCombined, `${art.name}\n${art.content}`, terms, regex);
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
        excerpt: buildCenteredSnippet(art.content, terms, regex),
      });
    }
  }

  if (wantSwarm && doc.board.length > 0) {
    for (let i = doc.board.length - 1; i >= 0; i -= 1) {
      const msg = doc.board[i]!;
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
        excerpt: buildCenteredSnippet(msg.text, terms, regex),
      });
    }
  }

  const requiredCount = regex ? 1 : terms.length;
  if (sessionTermsFound.size < requiredCount) {
    return { hit: null, skippedInFlight };
  }

  const topSnippets = selectDiverseSnippets(candidates, terms, maxSnippets);
  const titleScore =
    scope === "all" && titleMatched ? Math.round(10 * (titleHitCount / requiredCount)) : 0;
  const snippetScore = topSnippets.reduce((acc, s) => acc + s.score, 0);
  const hitBonus = Math.min(8, Math.log2(1 + candidates.length) * 2.5);
  const ageDays = entry.updatedMs > 0 ? Math.max(0, (now - entry.updatedMs) / (24 * 3600 * 1000)) : 30;
  const recencyBonus = 8 / (1 + ageDays / 1.5);
  const tinyUntitledPenalty = !entry.title && entry.stepCount > 0 && entry.stepCount <= 5 ? -6 : 0;

  const score = titleScore + snippetScore + hitBonus + recencyBonus + tinyUntitledPenalty;
  return {
    hit: {
      entry,
      score,
      totalHits: candidates.length,
      titleMatched,
      snippets: topSnippets,
    },
    skippedInFlight,
  };
}

function formatListedSessions(
  eligible: SessionEntry[],
  opts: {
    coverageLabel: string;
    scopeFilter: ScopeKey | null;
    workspace: string;
    maxSessions: number;
    maxChars: number;
    now: number;
  },
): ToolResult {
  const shown = eligible.slice(0, opts.maxSessions);
  const scopeNote = opts.scopeFilter ? `scope=${formatScopeKey(opts.scopeFilter)}` : `clients=${opts.coverageLabel}`;
  const wsNote = opts.workspace ? `, workspace~"${opts.workspace}"` : "";

  if (shown.length === 0) {
    return {
      text: `No matching conversations found (${scopeNote}${wsNote}).`,
      isError: false,
    };
  }

  const lines = [`Recent conversations (${shown.length} of ${eligible.length} shown; ${scopeNote}${wsNote}):`, ""];
  for (const s of shown) {
    const artifacts = listSessionArtifactFiles(s.paths.brainDir, { includeMeta: false });
    const wsName = s.workspaces[0] ? formatWorkspaceLabel(s.workspaces[0]) : "";
    const badges: string[] = [];
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
      s.stepCount > 0 ? `${s.stepCount} steps` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`- **${s.shortId}** (${s.sessionId}) — ${title}${badgeStr}`);
    lines.push(`  ${meta}`);
    if (s.preview && s.preview !== s.title) {
      lines.push(`  Preview: ${safeSliceChars(s.preview.replace(/\s+/g, " ").trim(), 140)}`);
    }
  }
  return { text: truncateUtf8(lines.join("\n"), opts.maxChars), isError: false };
}

export interface SearchSessionsOptions {
  dataDir?: string;
  query?: string;
  mode?: string;
  scope?: string;
  regex?: boolean;
  conversationId?: string;
  scopeKey?: string;
  allScopes?: boolean;
  workspace?: string;
  sessionId?: string;
  includeChildren?: boolean;
  excludeSessionId?: string;
  sinceDays?: number;
  maxSessions?: number;
  maxSnippetsPerSession?: number;
  maxChars?: number;
  maxScanBytes?: number;
  maxScanMs?: number;
}

export function searchSessionsResult(opts: SearchSessionsOptions = {}): ToolResult {
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
    maxScanMs,
  } = opts;

  const safeMode = String(mode || "text").trim().toLowerCase();
  if (!VALID_SEARCH_MODES.has(safeMode)) {
    return {
      text: `Error: Invalid mode "${mode}". Expected one of: text, file_history, error_history.`,
      isError: true,
    };
  }

  const targetSessionRef = String(sessionId || "").trim();
  const safeMaxSessions = Math.max(1, Math.min(25, Number(maxSessions) || 10));
  const safeMaxSnippets = Math.max(1, Math.min(8, Number(maxSnippetsPerSession) || 3));
  const safeMaxChars = clampMaxChars(maxChars, 8200);

  const { entries: catalog, coverageLabel } = loadMultiClientCatalog(dataDir);
  const now = Date.now();
  const minMs = sinceDays > 0 ? now - sinceDays * 24 * 3600 * 1000 : 0;

  let activeScopeFilter: ScopeKey | null = null;
  let effectiveExclude = excludeSessionId;

  if (!allScopes) {
    if (explicitScopeStr.trim()) {
      const parsed = parseExplicitScopeKey(explicitScopeStr);
      if (!parsed || parsed.kind === "global") {
        return { text: `Error: Invalid scopeKey "${explicitScopeStr}".`, isError: true };
      }
      activeScopeFilter = parsed;
    } else if (conversationId.trim()) {
      const ctx = resolveConversationContext({
        conversationId: conversationId.trim(),
        overrideDataDir: dataDir,
        catalog,
      });
      if (ctx.scopeKey.kind === "unresolved") {
        return {
          text: `Error: Could not resolve project scope for conversation "${conversationId}"${ctx.diagnostic ? ` (${ctx.diagnostic})` : ""}. Pass allScopes=true or workspace to search without project scoping.`,
          isError: true,
        };
      }
      activeScopeFilter = ctx.scopeKey;
      if (!targetSessionRef) {
        effectiveExclude = effectiveExclude ? `${effectiveExclude},${conversationId.trim()}` : conversationId.trim();
      }
    } else if (!targetSessionRef && !workspace.trim()) {
      return {
        text: 'Error: Pass conversationId (from [agy-memory] startup header) to stay scoped to your project, or set allScopes=true to search across all projects.',
        isError: true,
      };
    }
  }

  let eligible: SessionEntry[];
  if (targetSessionRef) {
    const resolved = resolveSessionEntry(dataDir, targetSessionRef, catalog);
    if (!resolved.entry) {
      return { text: `Error: ${resolved.error || `No conversation matched "${targetSessionRef}".`}`, isError: true };
    }
    const s = resolved.entry;
    const scopeMismatch = activeScopeFilter !== null && !scopeKeysEqual(s.scopeKey, activeScopeFilter);
    const excluded =
      scopeMismatch ||
      (effectiveExclude && matchesSessionId(s.sessionId, effectiveExclude, s.client)) ||
      (minMs > 0 && s.updatedMs < minMs) ||
      !workspaceMatches(s.workspaces, workspace);
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
      maxScanMs,
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
      maxScanMs,
    });
  }

  if (!String(query || "").trim()) {
    return formatListedSessions(eligible, {
      coverageLabel,
      scopeFilter: activeScopeFilter,
      workspace,
      maxSessions: safeMaxSessions,
      maxChars: safeMaxChars,
      now,
    });
  }

  const safeScope = String(scope || "all").trim().toLowerCase();
  if (!VALID_SCOPES.has(safeScope)) {
    return {
      text: `Error: Invalid scope "${scope}". Expected one of: all, user, assistant, artifacts, swarm.`,
      isError: true,
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
      now,
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
  const results: SessionSearchHit[] = [];
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
      budget,
    });
    if (skippedInFlight) skippedInFlightCount += 1;
    if (hit) results.push(hit);
  }

  results.sort((a, b) => b.score - a.score || b.entry.updatedMs - a.entry.updatedMs);
  const top = results.slice(0, safeMaxSessions);
  const incompleteNote = budget.incomplete
    ? `INCOMPLETE SCAN (${budget.sessionsScanned}/${toScan.length} candidates, ${(budget.bytesRead / (1024 * 1024)).toFixed(1)} MB; ${budget.reason}; narrow with workspace/sinceDays — do NOT treat 0-match as authoritative).`
    : "";

  const scopeDesc = activeScopeFilter ? `projectScope=${formatScopeKey(activeScopeFilter)}` : `clients=${coverageLabel}`;

  if (top.length === 0) {
    const scopeLabel = safeScope === "all" ? "transcripts, artifacts, and swarm boards" : safeScope;
    const filters: string[] = [];
    if (activeScopeFilter) filters.push(`projectScope=${formatScopeKey(activeScopeFilter)}`);
    if (workspace) filters.push(`workspace~"${workspace}"`);
    if (targetSessionRef) filters.push(`sessionId="${targetSessionRef}"`);
    if (skippedInFlightCount > 0) filters.push("excluded active in-flight prompt");
    const filterSuffix = filters.length > 0 ? `; ${filters.join(", ")}` : "";
    const statusLine = incompleteNote
      ? `\n${incompleteNote}`
      : `\nComplete scan (${eligible.length} eligible session(s), ${coverageLabel}).\nNote: text mode searches user/assistant replies, artifacts, and Swarm only; for failed commands/exit codes or tool file edits, try mode="error_history" or mode="file_history".`;
    return {
      text: `No past conversations matched "${query}" (searched ${eligible.length} session(s) [${scopeDesc}] across ${scopeLabel}${filterSuffix}).${statusLine}`,
      isError: false,
    };
  }

  const lines = [
    `Search "${query}" — ${results.length} matching conversation(s) (showing top ${top.length}, scope=${safeScope}, ${scopeDesc}${targetSessionRef ? `, session=${targetSessionRef}` : ""}):`,
  ];
  if (incompleteNote) lines.push(incompleteNote);

  for (const r of top) {
    const e = r.entry;
    const wsName = e.workspaces[0] ? formatWorkspaceLabel(e.workspaces[0]) : "";
    lines.push(
      `\n### ${e.shortId} — ${e.title || "(untitled)"} (${formatShortDate(e.updatedMs)}, ${formatRelativeTime(e.updatedMs, now)}${wsName ? `, ${wsName}` : ""})`,
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

export function searchSessionsFormatted(opts: SearchSessionsOptions = {}): string {
  return searchSessionsResult(opts).text;
}
