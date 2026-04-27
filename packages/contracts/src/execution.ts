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
    | "pr_summary"
    // v0.8.2.1 P1.4 — sanitized structured-output diagnostic captured
    // when a Claude runner's payload fails runtime schema validation.
    | "runner_diagnostic";
  uri: string;
  createdAt: string;
}

/**
 * Implementer committed one or more paths that the repository's ignore
 * policy (`.gitignore` and friends) says should never be tracked —
 * typically generated artifacts, build outputs, or local scratch files.
 * The integrator refuses to merge such commits and surfaces the
 * offending paths so the task can be re-planned or repaired.
 */
export interface IgnoredArtifactCommittedBlock {
  kind: "IGNORED_ARTIFACT_COMMITTED";
  /**
   * Repo-relative paths the implementer attempted to commit. At least
   * one entry is always populated when this block reason is raised;
   * ordering is not significant. Paths are POSIX-style ("/" separators)
   * relative to the repo root captured in the originating `WorktreeLease`.
   */
  paths: string[];
}

/**
 * Reason a task / agent run was blocked from progressing further.
 *
 * Modeled as a discriminated union (`kind` is the discriminator) so
 * each reason can carry its own structured context — for
 * `IGNORED_ARTIFACT_COMMITTED` that's the offending repo-relative
 * `paths`, for future variants it's whatever the blocker needs.
 *
 * Lives here in `execution.ts` (alongside `AgentRun` and
 * `WorktreeLease`) rather than as ad-hoc fields on the consumer side,
 * so phase-2 worker code (the integrator activity in `apps/worker`)
 * and any future pm-go task-repair flow share one canonical shape.
 *
 * Consumers should narrow by `kind` and treat the union as open: new
 * members get appended over time and downstream code is expected to
 * handle the unknown-kind case gracefully (e.g. exhaustiveness checks
 * with a `never`-assigned default branch).
 */
export type TaskBlockReason = IgnoredArtifactCommittedBlock;

/**
 * String-literal union of the `kind` discriminators on
 * `TaskBlockReason`. Useful for consumers that need to reference a
 * specific reason name without importing the full union variant — for
 * example, mapping persisted DB rows back into `TaskBlockReason` or
 * filtering events by reason kind.
 */
export type TaskBlockReasonKind = TaskBlockReason["kind"];

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
