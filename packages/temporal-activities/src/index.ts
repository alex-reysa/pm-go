import type {
  AgentRun,
  Artifact,
  CompletionAuditReport,
  FileScope,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
  PlanAuditWorkflowResult,
  PolicyDecision,
  RepoSnapshot,
  ReviewFinding,
  ReviewReport,
  SpecDocument,
  Task,
  TaskStatus,
  UUID,
  WorktreeLease,
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

/**
 * A persisted MergeRun enriched with Phase 5's DB-only linkage:
 * - `postMergeSnapshotId` — FK to the `repo_snapshots` row captured
 *   immediately after the integration merge succeeded. Null while the
 *   run is in flight. Non-null on success. This is the durable hook
 *   PhasePartitionWorkflow reads to see the post-merge repo state for
 *   phase N+1.
 * - `integrationLeaseId` — FK to the `worktree_leases` row hosting the
 *   integration worktree. May be null after the lease is released; the
 *   merge_runs row survives lease cleanup.
 */
export type StoredMergeRun = MergeRun & {
  postMergeSnapshotId?: UUID;
  integrationLeaseId?: UUID;
};

/**
 * A persisted PhaseAuditReport row. The contract `PhaseAuditReport`
 * already carries every field; this alias exists as a symmetric type
 * for consistency with StoredReviewReport / StoredMergeRun.
 */
export type StoredPhaseAuditReport = PhaseAuditReport;

/**
 * A persisted CompletionAuditReport row. Alias for consistency.
 */
export type StoredCompletionAuditReport = CompletionAuditReport;

/**
 * Phase 5 integration activities — git + lease + persistence operations
 * executed by `PhaseIntegrationWorkflow`. The merge path ALWAYS happens
 * inside an isolated integration worktree (kind='integration'); no
 * operation checks out a branch in `repoRoot` itself. `main` advancement
 * happens in `PhaseAuditWorkflow` on a pass outcome, not here.
 */
export interface IntegrationActivities {
  loadPhase(input: { phaseId: UUID }): Promise<Phase>;
  runPhasePartitionChecks(input: { phaseId: UUID }): Promise<{
    ok: boolean;
    reasons: string[];
  }>;
  createIntegrationLease(input: { phaseId: UUID }): Promise<WorktreeLease>;
  integrateTask(input: {
    integrationLease: WorktreeLease;
    taskId: UUID;
  }): Promise<
    | { status: "merged"; mergedHeadSha: string }
    | { status: "conflict"; conflictedPaths: string[] }
    | { status: "other_error"; message: string }
  >;
  validatePostMergeState(input: {
    integrationWorktreePath: string;
    testCommands: string[];
  }): Promise<{ passed: boolean; logs: string[] }>;
  /**
   * Capture a post-merge snapshot and stamp it on the `merge_runs` row
   * in a single DB transaction. If `nextPhaseId` is provided, also
   * updates that phase's `base_snapshot_id` transactionally so the
   * post-merge RepoSnapshot only propagates once the prior phase's
   * integration completed. `nextPhaseId` is typically undefined here
   * and set by `PhaseAuditWorkflow` on pass — keeping the hook on this
   * activity for workflow flexibility.
   */
  capturePostMergeSnapshotAndStamp(input: {
    integrationWorktreePath: string;
    mergeRunId: UUID;
    nextPhaseId?: UUID;
  }): Promise<{ snapshotId: UUID }>;
  persistMergeRun(run: StoredMergeRun): Promise<UUID>;
  loadMergeRun(id: UUID): Promise<StoredMergeRun | null>;
  loadLatestMergeRunForPhase(phaseId: UUID): Promise<StoredMergeRun | null>;
  /**
   * Advance `refs/heads/main` via `git update-ref refs/heads/main <new>
   * <expected-old>`. Atomic, no checkout, refuses on expected-old
   * mismatch OR non-descendant update. Called ONLY from
   * `PhaseAuditWorkflow` on pass.
   */
  fastForwardMainViaUpdateRef(input: {
    newSha: string;
    expectedCurrentSha: string;
  }): Promise<{ headSha: string }>;
  markTaskMerged(input: { taskId: UUID }): Promise<void>;
  updatePhaseStatus(input: {
    phaseId: UUID;
    status:
      | "pending"
      | "planning"
      | "executing"
      | "integrating"
      | "auditing"
      | "completed"
      | "blocked"
      | "failed";
  }): Promise<void>;
  releaseIntegrationLease(input: { leaseId: UUID }): Promise<void>;
  stampPhaseAuditReportId(input: {
    phaseId: UUID;
    reportId: UUID;
  }): Promise<void>;
  stampPhaseBaseSnapshotId(input: {
    phaseId: UUID;
    snapshotId: UUID;
  }): Promise<void>;
}

export interface PhaseAuditActivities {
  runPhaseAuditor(input: {
    plan: Plan;
    phase: Phase;
    mergeRun: StoredMergeRun;
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: PhaseAuditReport; agentRun: AgentRun }>;
  buildPhaseAuditEvidence(input: {
    planId: UUID;
    phaseId: UUID;
    mergeRunId: UUID;
  }): Promise<{
    tasks: Task[];
    reviewReports: ReviewReport[];
    policyDecisions: PolicyDecision[];
    diffSummary: string;
  }>;
  persistPhaseAuditReport(
    report: StoredPhaseAuditReport,
  ): Promise<UUID>;
  loadLatestPhaseAuditForPhase(
    phaseId: UUID,
  ): Promise<StoredPhaseAuditReport | null>;
  loadPhaseAuditReport(id: UUID): Promise<StoredPhaseAuditReport | null>;
}

export interface CompletionAuditActivities {
  runCompletionAuditor(input: {
    plan: Plan;
    finalPhase: Phase;
    finalMergeRun: StoredMergeRun;
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: CompletionAuditReport; agentRun: AgentRun }>;
  buildCompletionAuditEvidence(input: {
    planId: UUID;
    finalPhaseId: UUID;
    mergeRunId: UUID;
  }): Promise<{
    phases: Phase[];
    phaseAuditReports: PhaseAuditReport[];
    mergeRuns: MergeRun[];
    reviewReports: ReviewReport[];
    policyDecisions: PolicyDecision[];
    diffSummary: string;
  }>;
  persistCompletionAuditReport(
    report: StoredCompletionAuditReport,
  ): Promise<UUID>;
  loadCompletionAuditReport(
    id: UUID,
  ): Promise<StoredCompletionAuditReport | null>;
  /**
   * Update `plans.completion_audit_report_id` + `plans.status`
   * transactionally on a completion audit verdict.
   */
  stampPlanCompletionAudit(input: {
    planId: UUID;
    reportId: UUID;
    planStatus:
      | "draft"
      | "auditing"
      | "approved"
      | "blocked"
      | "executing"
      | "completed"
      | "failed";
  }): Promise<void>;
  renderAndPersistPrSummary(input: {
    planId: UUID;
    completionAuditReportId: UUID;
  }): Promise<{ artifactId: UUID; uri: string }>;
  persistCompletionEvidenceBundle(input: {
    planId: UUID;
    completionAuditReportId: UUID;
  }): Promise<{ artifactId: UUID; uri: string }>;
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
