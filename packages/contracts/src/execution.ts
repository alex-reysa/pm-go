import type { RiskLevel, UUID } from "./plan.js";

export type AgentRole =
  | "planner"
  | "partitioner"
  | "implementer"
  | "auditor"
  | "integrator"
  | "release-reviewer"
  | "explorer";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "canceled";

export type WorktreeLeaseStatus = "active" | "expired" | "released" | "revoked";

export interface SpecDocument {
  id: UUID;
  title: string;
  source: "manual" | "imported";
  body: string;
  createdAt: string;
}

export interface RepoSnapshot {
  id: UUID;
  repoRoot: string;
  repoUrl?: string;
  defaultBranch: string;
  headSha: string;
  languageHints: string[];
  frameworkHints: string[];
  buildCommands: string[];
  testCommands: string[];
  ciConfigPaths: string[];
  capturedAt: string;
}

export type AgentStopReason =
  | "completed"
  | "budget_exceeded"
  | "turns_exceeded"
  | "timeout"
  | "canceled"
  | "error"
  | "scope_violation";

export type AgentPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface AgentRun {
  id: UUID;
  taskId?: UUID;
  workflowRunId: string;
  role: AgentRole;
  depth: 0 | 1 | 2;
  status: AgentRunStatus;
  riskLevel: RiskLevel;
  executor: "claude";
  model: string;
  promptVersion: string;
  sessionId?: string;
  parentSessionId?: string;
  permissionMode: AgentPermissionMode;
  budgetUsdCap?: number;
  maxTurnsCap?: number;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  stopReason?: AgentStopReason;
  outputFormatSchemaRef?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorktreeLease {
  id: UUID;
  taskId: UUID;
  repoRoot: string;
  branchName: string;
  worktreePath: string;
  baseSha: string;
  expiresAt: string;
  status: WorktreeLeaseStatus;
}

export interface Artifact {
  id: UUID;
  taskId?: UUID;
  planId?: UUID;
  kind:
    | "plan_markdown"
    | "review_report"
    | "completion_audit_report"
    | "completion_evidence_bundle"
    | "test_report"
    | "event_log"
    | "patch_bundle"
    | "pr_summary";
  uri: string;
  createdAt: string;
}

export interface MergeRun {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  integrationBranch: string;
  mergedTaskIds: UUID[];
  failedTaskId?: UUID;
  integrationHeadSha?: string;
  startedAt: string;
  completedAt?: string;
}
