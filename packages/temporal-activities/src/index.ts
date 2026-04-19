import type {
  AgentRun,
  Artifact,
  FileScope,
  MergeRun,
  Plan,
  PlanAuditWorkflowResult,
  PolicyDecision,
  RepoSnapshot,
  CompletionAuditReport,
  PhaseAuditReport,
  ReviewFinding,
  ReviewReport,
  SpecDocument,
  Task,
  TaskStatus,
  UUID,
  WorktreeLease
} from "@pm-go/contracts";

export interface SpecIntakeActivities {
  persistSpecDocument(input: SpecDocument): Promise<UUID>;
  collectRepoSnapshot(repoRoot: string): Promise<RepoSnapshot>;
}

export interface PlanningActivities {
  persistPlan(plan: Plan): Promise<UUID>;
  renderPlanMarkdown(planId: UUID): Promise<UUID>;
  loadSpecDocument(specDocumentId: UUID): Promise<SpecDocument>;
  loadRepoSnapshot(repoSnapshotId: UUID): Promise<RepoSnapshot>;
  generatePlan(input: {
    specDocumentId: UUID;
    repoSnapshotId: UUID;
    requestedBy: string;
  }): Promise<{ plan: Plan; agentRun: AgentRun }>;
  auditPlan(
    plan: Plan
  ): Promise<PlanAuditWorkflowResult & { findings: ReviewFinding[] }>;
  persistAgentRun(run: AgentRun): Promise<UUID>;
  persistArtifact(artifact: Artifact): Promise<UUID>;
}

export interface RepoIntelligenceActivities {
  collectRepoSnapshot(input: { repoRoot: string }): Promise<RepoSnapshot>;
  persistRepoSnapshot(snapshot: RepoSnapshot): Promise<UUID>;
}

export interface ExecutionActivities {
  leaseWorktree(task: Task): Promise<{ branchName: string; worktreePath: string }>;
  runImplementer(taskId: UUID): Promise<UUID>;
  collectExecutionOutcome(taskId: UUID): Promise<{ readyForReview: boolean }>;
}

/**
 * Fix-mode context supplied to `TaskExecutionActivities.runImplementer` on
 * review-fix cycles. The underlying runner prepends a deterministic "Fix
 * mode" preamble to the implementer system prompt when this is present.
 * Absent on the first (non-fix) implementer run.
 */
export interface RunImplementerReviewFeedback {
  reportId: UUID;
  cycleNumber: number;
  maxCycles: number;
  findings: ReviewFinding[];
}

/**
 * A persisted review report enriched with the DB-side fields that are
 * not on the wire `ReviewReport` contract:
 * - `cycleNumber` — 1-indexed fix cycle this review evaluated.
 * - `reviewedBaseSha` / `reviewedHeadSha` — the commit range the
 *   reviewer actually diff'd. Pinning these on the row is what lets a
 *   future reader reconstruct the exact audited commit window after
 *   more fix cycles have appended commits to the same task branch.
 *
 * Persistence + load activities operate on this enriched shape.
 */
export type StoredReviewReport = ReviewReport & {
  cycleNumber: number;
  reviewedBaseSha: string;
  reviewedHeadSha: string;
};

export interface ReviewActivities {
  runReviewer(input: {
    task: Task;
    worktreePath: string;
    baseSha: string;
    headSha: string;
    cycleNumber: number;
    previousFindings?: ReviewFinding[];
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: ReviewReport; agentRun: AgentRun }>;
  persistReviewReport(report: StoredReviewReport): Promise<UUID>;
  loadReviewReport(reportId: UUID): Promise<StoredReviewReport | null>;
  loadLatestReviewReport(taskId: UUID): Promise<StoredReviewReport | null>;
  loadReviewReportsByTask(taskId: UUID): Promise<StoredReviewReport[]>;
  /** Returns the highest cycleNumber seen for this task, or 0 if no reviews yet. */
  countFixCyclesForTask(taskId: UUID): Promise<number>;
  persistPolicyDecision(decision: PolicyDecision): Promise<UUID>;
}

export interface IntegrationActivities {
  mergePhase(phaseId: UUID): Promise<MergeRun>;
  runTargetedValidation(taskId: UUID): Promise<boolean>;
  runPhaseIntegrationValidation(phaseId: UUID): Promise<boolean>;
}

export interface PhaseAuditActivities {
  runPhaseAudit(planId: UUID, phaseId: UUID, mergeRunId: UUID): Promise<UUID>;
  persistPhaseAuditReport(report: PhaseAuditReport): Promise<UUID>;
}

export interface CompletionAuditActivities {
  collectCompletionEvidence(planId: UUID, finalMergeRunId: UUID): Promise<UUID>;
  runCompletionAudit(planId: UUID, finalMergeRunId: UUID): Promise<UUID>;
  persistCompletionAuditReport(report: CompletionAuditReport): Promise<UUID>;
}

export interface WorktreeActivities {
  leaseWorktree(input: {
    task: Task;
    repoRoot: string;
    worktreeRoot: string;
    maxLifetimeHours: number;
  }): Promise<WorktreeLease>;
  persistLease(lease: WorktreeLease): Promise<string>;
  releaseLease(input: { leaseId: string }): Promise<void>;
  revokeExpiredLease(input: { leaseId: string }): Promise<void>;
  detectDirtyWorktree(input: { worktreePath: string }): Promise<{
    dirty: boolean;
    unknownFiles: string[];
    modifiedFiles: string[];
  }>;
  diffWorktreeAgainstScope(input: {
    worktreePath: string;
    baseSha: string;
    fileScope: FileScope;
  }): Promise<{ changedFiles: string[]; violations: string[] }>;
}

export interface TaskExecutionActivities {
  loadTask(input: { taskId: UUID }): Promise<Task>;
  updateTaskStatus(input: { taskId: UUID; status: TaskStatus }): Promise<void>;
  runImplementer(input: {
    task: Task;
    worktreePath: string;
    baseSha: string;
    reviewFeedback?: RunImplementerReviewFeedback;
  }): Promise<{ agentRun: AgentRun; finalCommitSha?: string }>;
}
