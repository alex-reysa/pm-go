import type { AgentStopReason, UUID } from "@pm-go/contracts";

export type RuntimeMode = "auto" | "stub" | "sdk" | "claude";
export type ApprovalMode = "all" | "none" | "interactive";

export interface OperatorAgentOptions {
  repoRoot?: string;
  specPath?: string;
  title?: string;
  runtime: RuntimeMode;
  approve: ApprovalMode;
  yes: boolean;
  /** Compatibility alias from apps/cli's root parser. */
  resume?: string;
  resumeSessionId?: string;
  apiPort?: number;
  apiUrl?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface OperatorAgentResult {
  agentRunId: UUID;
  sessionId?: string;
  status: "completed" | "failed";
  turns: number;
  costUsd?: number;
  stopReason?: AgentStopReason;
  errorReason?: string;
  text: string;
}

export interface ToolCallRecord {
  id: UUID;
  agentRunId: UUID;
  sequence: number;
  toolName: string;
  sanitizedInput: unknown;
  summarizedOutput?: unknown;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  errorReason?: string;
  specDocumentId?: UUID;
  repoSnapshotId?: UUID;
  planId?: UUID;
  phaseId?: UUID;
  taskId?: UUID;
}
