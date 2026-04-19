import type {
  AgentRun,
  Artifact,
  FileScope,
  MergeRun,
  Plan,
  PlanAuditWorkflowResult,
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

export interface ReviewActivities {
  runReviewer(taskId: UUID): Promise<UUID>;
  persistReviewReport(report: ReviewReport): Promise<UUID>;
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
  }): Promise<{ agentRun: AgentRun; finalCommitSha?: string }>;
}
