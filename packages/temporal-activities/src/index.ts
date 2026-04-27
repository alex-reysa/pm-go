import type {
  AgentRun,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  BudgetDecision,
  BudgetReport,
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
  Span,
  SpecDocument,
  StopDecision,
  StoredReviewReport,
  Task,
  TaskStatus,
  UUID,
  WorktreeLease,
} from "@pm-go/contracts";

// Re-export for back-compat with Phase 4 call sites that imported
// StoredReviewReport from this package.
export type { StoredReviewReport };

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
    /**
     * API-supplied plan UUID. The activity rewrites the model-returned
     * `plan.id` to this value before validation completes, so the
     * persisted `plans.id` matches the id the caller (the API's
     * `POST /plans` handler) committed to in its 202 response.
     */
    planId?: UUID;
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
    // Pass the full persisted shape — `reviewedBaseSha` / `reviewedHeadSha`
    // carry the audit-relevant commit provenance. Bare `ReviewReport[]`
    // would drop that at the boundary.
    reviewReports: StoredReviewReport[];
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
    reviewReports: StoredReviewReport[];
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

/**
 * Phase 7 — Worker 4. Policy-gate activities.
 *
 * The four pure-function evaluators in `@pm-go/policy-engine`
 * (evaluateBudgetGate / evaluateApprovalGate / evaluateRetryDecision /
 * evaluateStopCondition) live behind these activity interfaces because
 * Temporal workflows must not perform I/O. Each activity loads the live
 * state required by the evaluator from the durable store, calls the
 * pure function, and returns the decision plus, where necessary, the
 * persisted side-effect (e.g. the `approvalRequestId` for a freshly
 * created `approval_requests` row).
 *
 * Workflow callers proxy these and either branch on the decision (e.g.
 * transition the task to `blocked`, persist a `policy_decisions` row)
 * or block on a follow-up `isApproved` poll (the approval gate path).
 */
export interface PolicyEngineActivities {
  /**
   * Pre-flight budget gate for a single task. Loads the task row + every
   * `agent_runs` row associated with it, calls
   * `evaluateBudgetGate(task, runs)`, and returns the pure decision.
   * On `ok: false` the workflow is expected to (a) update the task to
   * `blocked` via `updateTaskStatus` and (b) persist a
   * `policy_decisions` row via `persistPolicyDecision` (existing
   * `ReviewActivities`). Both side-effects live in the workflow so
   * Temporal can record them as discrete activity invocations.
   */
  evaluateBudgetGateActivity(input: {
    taskId: UUID;
  }): Promise<BudgetDecision>;

  /**
   * Pre-merge approval gate for a single task in a phase being
   * integrated. Loads the task + the highest-priority `Risk` row from
   * its plan that names the task's risk level, calls
   * `evaluateApprovalGate(risk, task)`, and — when the decision says
   * approval is required — inserts a fresh `approval_requests` row with
   * `status='pending'`. Returns the decision plus the
   * `approvalRequestId` so the workflow can poll on it.
   *
   * The activity is idempotent on Temporal retries: it looks for an
   * existing `pending` row for the same plan/task before inserting.
   */
  evaluateApprovalGateActivity(input: {
    taskId: UUID;
  }): Promise<{
    decision: ApprovalDecision;
    approvalRequestId?: UUID;
  }>;

  /**
   * Plan-level stop condition. Loads the plan + the supplied task's
   * review-cycle count + outstanding review findings, calls
   * `evaluateStopCondition(plan, cycles, findings, limits)`, and
   * returns the pure decision. The workflow is expected to persist a
   * `policy_decisions` row citing the reason on `stop: true`.
   */
  evaluateStopConditionActivity(input: {
    planId: UUID;
    /** Optional task scope — review-cycle count is task-scoped. */
    taskId?: UUID;
  }): Promise<StopDecision>;

  /**
   * Idempotently persist an `approval_requests` row with an explicit
   * status (typically `pending`). Returns the row id. This is exposed
   * separately from `evaluateApprovalGateActivity` so the API
   * `POST /plans/:id/approve` and `POST /tasks/:id/approve` paths can
   * write through the same primitive.
   */
  persistApprovalRequest(request: ApprovalRequest): Promise<UUID>;

  /**
   * Aggregate every `agent_runs` row for the plan, build a
   * `BudgetReport` snapshot, persist it onto `budget_reports`, and
   * return the row. Called from the orchestrator at phase-integration
   * and plan-completion time as well as from `GET /plans/:id/budget-report`.
   */
  persistBudgetReport(input: { planId: UUID }): Promise<BudgetReport>;

  /**
   * Cheap polling helper used by workflows blocked on a pending
   * approval. Returns true when the matching `approval_requests` row's
   * status flips to `approved`, false otherwise (or when the row was
   * `rejected` — the workflow caller is expected to escalate).
   */
  isApproved(input: {
    approvalRequestId: UUID;
  }): Promise<{ approved: boolean; rejected: boolean }>;
}

/**
 * Phase 7 — Worker 4. Span-persistence activity.
 *
 * Most spans flow through `withSpan` automatically (the writer is
 * constructed inside each wrapped activity). This interface exists for
 * the minority case where a span's open and close need to be disjoint
 * (e.g. an operator action recorded from the API surface). Workers may
 * call `persistSpan` directly with a fully-formed `Span` payload.
 */
export interface SpanPersistenceActivities {
  persistSpan(input: { planId: UUID; span: Span }): Promise<void>;
}
