export type ClientKind = "app" | "cli" | "ide" | "custom";

export interface ClientDataRoot {
  client: ClientKind;
  dataDir: string;
}

export type ScopeKey =
  | { kind: "project"; projectId: string }
  | { kind: "cli_repo"; commonGitDir: string }
  | { kind: "cli_workspace"; root: string }
  | { kind: "global" }
  | { kind: "unresolved"; reason?: string };

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface SessionPaths {
  brainDir: string;
  systemDir: string;
  transcriptPath: string;
  transcriptFullPath: string;
  swarmDir: string;
  swarmMembersPath: string;
  swarmBoardPath: string;
  swarmPlanPath: string;
  subagentsDir: string;
}

export interface RawSummaryRow {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaceUris: string | string[];
  status: string;
  projectId: string;
  appDataDir: string;
  notFullyIdle: boolean;
  parentConversationId: string;
  nestingDepth: number;
  lastUserInputTime: string;
}

export interface SessionEntry {
  client: ClientKind;
  dataDir: string;
  canonicalId: string;
  sessionId: string;
  shortId: string;
  title: string;
  preview: string;
  stepCount: number;
  updatedMs: number;
  workspaces: string[];
  status: string;
  projectId: string;
  notFullyIdle: boolean;
  scopeKey: ScopeKey;
  isChild: boolean;
  parentConversationId: string;
  hasTranscript: boolean;
  hasSwarm: boolean;
  paths: SessionPaths;
}

export interface ArtifactInfo {
  name: string;
  path: string;
  summary: string;
  updatedAt: number;
  size: number;
}

export interface AssistantResponseRecord {
  stepIndex: number;
  createdAt: string;
  text: string;
  contentTruncated: boolean;
  hydrated?: boolean;
}

export interface ToolCallRecord {
  stepIndex: number;
  name: string;
}

export interface ThoughtRecord {
  stepIndex: number;
  text: string;
}

export interface TranscriptTurn {
  turnIndex: number;
  startStep: number;
  endStep: number;
  createdAt: string;
  userStepIndex: number;
  userText: string;
  userContentTruncated: boolean;
  assistantResponses: AssistantResponseRecord[];
  tools: ToolCallRecord[];
  thoughts: ThoughtRecord[];
  models: string[];
  finalAssistantText: string;
  finalAssistantTruncated: boolean;
  hydratedFromFull?: boolean;
}

export interface SwarmBoardMessage {
  seq: number;
  time: string;
  agent: string;
  kind: string;
  text: string;
}

export interface SearchableMessage {
  stepIndex: number;
  role: "user" | "assistant";
  date: string;
  text: string;
  lowText: string;
}

export interface SearchableArtifact {
  name: string;
  path: string;
  updatedAt: number;
  lineCount: number;
  content: string;
  lowCombined: string;
}

export interface SearchableBoardMessage extends SwarmBoardMessage {
  date: string;
  lowText: string;
}

export interface SearchableSessionDoc {
  messages: SearchableMessage[];
  artifacts: SearchableArtifact[];
  board: SearchableBoardMessage[];
  latestTranscriptMtimeMs: number;
  inFlightUserStepIndex: number;
}

export type FileActionOutcome = "read" | "write_succeeded" | "write_failed" | "write_unverified";

export interface TraceFileEvent {
  stepIndex: number;
  date: string;
  toolName: string;
  rawPath: string;
  resolvedPath: string;
  basename: string;
  outcome: FileActionOutcome;
  userPrompt: string;
  assistantSnippet: string;
}

export interface TraceErrorEvent {
  stepIndex: number;
  resultStepIndex: number;
  date: string;
  toolName: string;
  invocation: string;
  errorSnippet: string;
  exitCode: number | null;
  commandKey: string;
  userPrompt: string;
}

export interface TracePassEvent {
  stepIndex: number;
  date: string;
  toolName: string;
  invocation: string;
  commandKey: string;
}

export interface SessionTraceDoc {
  fileEvents: TraceFileEvent[];
  errorEvents: TraceErrorEvent[];
  passEvents: TracePassEvent[];
}

export interface ScanBudget {
  maxScanBytes: number;
  maxScanMs: number;
  startedAtMs: number;
  bytesRead: number;
  sessionsScanned: number;
  incomplete: boolean;
  reason: string;
}

export interface BoardSourceRef {
  client: ClientKind;
  conversationId: string;
  step?: number;
}

export interface BoardEntry {
  key: string;
  title: string;
  body: string;
  revision: string;
  updatedAt: number;
  scope: ScopeKey;
  source?: BoardSourceRef;
  filePath: string;
}
