import type { SignalDefinition } from "@temporalio/workflow";
import type { MergeRun } from "./execution.js";
import type { Plan, Task, UUID } from "./plan.js";
import type { CompletionAuditReport, PhaseAuditReport, ReviewReport } from "./review.js";

/**
 * Sent by an operator (or auto-approve logic) to unblock a plan or phase that
 * is waiting for human sign-off. The workflow handler resolves the pending
 * approval promise on receipt.
 *
 * Using a manually-constructed object (rather than `defineSignal`) keeps
 * `@temporalio/workflow` out of the contracts package's runtime dependencies
 * while maintaining full type compatibility with `setHandler` / `getExternalWorkflowHandle`.
 */
export const approveSignal: SignalDefinition<[]> = {
  type: "signal",
  name: "approve",
} as SignalDefinition<[]>;

export interface SpecToPlanWorkflowInput {
  specDocumentId: UUID;
  repoSnapshotId: UUID;
  requestedBy: string;
}

export interface SpecToPlanWorkflowResult {
  plan: Plan;
  renderedPlanArtifactId?: UUID;
}

export interface PlanAuditWorkflowInput {
  planId: UUID;
  requestedBy: string;
}

export interface PlanAuditWorkflowResult {
  planId: UUID;
  approved: boolean;
  revisionRequested: boolean;
}

export interface PhasePartitionWorkflowInput {
  planId: UUID;
  phaseId: UUID;
}

export interface PhasePartitionWorkflowResult {
  planId: UUID;
  phaseId: UUID;
  partitionedTasks: Task[];
}

export interface TaskExecutionWorkflowInput {
  taskId: UUID;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
  requestedBy: string;
}

export interface TaskExecutionWorkflowResult {
  taskId: UUID;
  status: "ready_for_review" | "ready_to_merge" | "blocked" | "failed";
  leaseId: UUID;
  branchName: string;
  worktreePath: string;
  agentRunId: UUID;
  changedFiles: string[];
  fileScopeViolations: string[];
  /**
   * When the small-task fast path applies, names the policy_decisions row
   * the workflow persisted as the audit trail for the skipped review.
   * Absent on every other terminal status.
   */
  reviewSkippedPolicyDecisionId?: UUID;
}

export interface TaskReviewWorkflowInput {
  taskId: UUID;
}

export interface TaskReviewWorkflowResult {
  taskId: UUID;
  report: ReviewReport;
}

export interface TaskFixWorkflowInput {
  taskId: UUID;
  reviewReportId: UUID;
}

export interface TaskFixWorkflowResult {
  taskId: UUID;
  completed: boolean;
  retryReview: boolean;
}

export interface PhaseIntegrationWorkflowInput {
  planId: UUID;
  phaseId: UUID;
}

export interface PhaseIntegrationWorkflowResult {
  phaseId: UUID;
  mergeRun: MergeRun;
}

export interface PhaseAuditWorkflowInput {
  planId: UUID;
  phaseId: UUID;
  mergeRunId: UUID;
  requestedBy: string;
}

export interface PhaseAuditWorkflowResult {
  planId: UUID;
  phaseId: UUID;
  report: PhaseAuditReport;
  phaseReady: boolean;
}

export interface CompletionAuditWorkflowInput {
  planId: UUID;
  finalPhaseId: UUID;
  mergeRunId: UUID;
  requestedBy: string;
}

export interface CompletionAuditWorkflowResult {
  planId: UUID;
  report: CompletionAuditReport;
  readyForRelease: boolean;
}

export interface FinalReleaseWorkflowInput {
  planId: UUID;
  completionAuditReportId: UUID;
}

export interface FinalReleaseWorkflowResult {
  planId: UUID;
  completionAuditReportId: UUID;
  sourceOfTruthArtifactId: UUID;
  outputArtifactIds: UUID[];
  pullRequestUrl?: string;
}
