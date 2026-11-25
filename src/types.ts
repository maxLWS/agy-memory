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
  parentConversationId: string;
  nestingDepth: number;
  lastUserInputTime: string;
}

export interface SessionEntry {
  sessionId: string;
  shortId: string;
  title: string;
  preview: string;
  stepCount: number;
  updatedMs: number;
  workspaces: string[];
  status: string;
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

export interface NoteItem {
  id: string;
  topic: string;
  content: string;
  workspace: string;
  tags: string[];
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryToolCallCounts {
  list_sessions: number;
  search_sessions: number;
  read_session: number;
  save_note: number;
  recall_notes: number;
}

export interface MemoryUsageBucket {
  sessions: number;
  sessionsWithSnapshot: number;
  sessionsWithMemoryTools: number;
  llmTurns: number;
  totalToolCalls: number;
  memoryToolCalls: MemoryToolCallCounts;
  rawBrainReads: number;
  mcpSpills: number;
  budgetTruncations: number;
  toolErrors: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface FinalizedMemoryUsageBucket extends MemoryUsageBucket {
  memoryToolCallsTotal: number;
  avgTurnsPerSession: number;
  estBillableEquiv: number;
}

export interface MemoryUsageReport {
  dataDir: string;
  analyzedLimit: number;
  overall: FinalizedMemoryUsageBucket;
  withAgyMemory: FinalizedMemoryUsageBucket;
  withoutAgyMemory: FinalizedMemoryUsageBucket;
}
