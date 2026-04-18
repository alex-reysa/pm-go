import type {
  MergeRun,
  Plan,
  RepoSnapshot,
  CompletionAuditReport,
  ReviewReport,
  SpecDocument,
  Task,
  UUID
} from "../../contracts/src/index.js";

export interface SpecIntakeActivities {
  persistSpecDocument(input: SpecDocument): Promise<UUID>;
  collectRepoSnapshot(repoRoot: string): Promise<RepoSnapshot>;
}

export interface PlanningActivities {
  persistPlan(plan: Plan): Promise<UUID>;
  renderPlanMarkdown(planId: UUID): Promise<UUID>;
}

export interface ExecutionActivities {
  leaseWorktree(task: Task): Promise<{ branchName: string; worktreePath: string }>;
  runImplementer(taskId: UUID): Promise<UUID>;
  collectExecutionOutcome(taskId: UUID): Promise<{ readyForReview: boolean }>;
}

export interface ReviewActivities {
  runReviewer(taskId: UUID): Promise<UUID>;
  persistReviewReport(report: ReviewReport): Promise<UUID>;
}

export interface IntegrationActivities {
  mergeTask(taskId: UUID): Promise<MergeRun>;
  runTargetedValidation(taskId: UUID): Promise<boolean>;
  runIntegrationValidation(planId: UUID): Promise<boolean>;
}

export interface CompletionAuditActivities {
  collectCompletionEvidence(planId: UUID, mergeRunId: UUID): Promise<UUID>;
  runCompletionAudit(planId: UUID, mergeRunId: UUID): Promise<UUID>;
  persistCompletionAuditReport(report: CompletionAuditReport): Promise<UUID>;
}
