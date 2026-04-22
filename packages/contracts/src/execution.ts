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

/**
 * Lease kind. `"task"` leases host a single implementer's worktree and
 * are tied to a `plan_tasks` row. `"integration"` leases (Phase 5) host
 * a phase's integration worktree and are tied to a `phases` row. The
 * durable check constraint in `worktree_leases` enforces the correlation
 * between `kind`, `task_id`, and `phase_id`.
 */
export type WorktreeLeaseKind = "task" | "integration";

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
  /**
   * Populated when `status === 'failed'` / `status === 'timed_out'` to
   * carry a short, operator-facing reason through to durable storage.
   * Sourced from `ExecutorError.errorReason` in `@pm-go/executor-claude`
   * for classified SDK failures (e.g. `"content_filter: ..."`), or from
   * the raw exception message otherwise. Never embeds API keys or full
   * prompt bodies.
   */
  errorReason?: string;
}

export interface WorktreeLease {
  id: UUID;
  /**
   * Populated for `kind='task'` (the Phase 3 default). Undefined for
   * integration leases, which bind via `phaseId` instead.
   */
  taskId?: UUID;
  /**
   * Populated for `kind='integration'` (added in Phase 5). Undefined for
   * task leases.
   */
  phaseId?: UUID;
  /**
   * Lease kind. Optional for backward compatibility with Phase 3 code
   * paths that predate the distinction; absent implies `"task"`.
   */
  kind?: WorktreeLeaseKind;
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
  /**
   * Commit the integration branch was forked from at the start of this
   * merge run (HEAD of `phase.baseSnapshotId`'s RepoSnapshot at merge
   * time). Pairs with `integrationHeadSha` to define the merge window
   * this run produced.
   */
  baseSha: string;
  planId: UUID;
  phaseId: UUID;
  integrationBranch: string;
  mergedTaskIds: UUID[];
  failedTaskId?: UUID;
  integrationHeadSha?: string;
  startedAt: string;
  completedAt?: string;
}
