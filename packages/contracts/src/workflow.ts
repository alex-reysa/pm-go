import type { MergeRun } from "./execution.js";
import type { Plan, Task, UUID } from "./plan.js";
import type { CompletionAuditReport, PhaseAuditReport, ReviewReport } from "./review.js";

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
}

export interface TaskExecutionWorkflowResult {
  taskId: UUID;
  branchName: string;
  worktreePath: string;
  readyForReview: boolean;
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
