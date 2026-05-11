/**
 * Desktop live read-model types.
 *
 * The API returns a mix of canonical pm-go contract objects and narrow
 * endpoint projections. `@pm-go/desktop` does not currently declare
 * `@pm-go/contracts` as a package dependency, so this module keeps the
 * contract-compatible structural subset local and documents every
 * projection gap at the read-model boundary. Once Desktop owns that
 * dependency, these `Contract*` types can be replaced by imports.
 */

export type UUID = string;
export type IsoTimestamp = string;

export type RiskLevel = "low" | "medium" | "high";
export type PlanStatus =
  | "draft"
  | "auditing"
  | "approved"
  | "blocked"
  | "executing"
  | "completed"
  | "released"
  | "failed";
export type PhaseStatus =
  | "pending"
  | "planning"
  | "executing"
  | "integrating"
  | "auditing"
  | "completed"
  | "blocked"
  | "failed";
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "in_review"
  | "fixing"
  | "ready_to_merge"
  | "merged"
  | "blocked"
  | "failed";
export type TaskKind =
  | "foundation"
  | "implementation"
  | "review"
  | "integration"
  | "release"
  | "feature"
  | "fix"
  | "refactor"
  | "chore"
  | "docs"
  | "test";
export type ApprovalStatus = "pending" | "approved" | "skipped" | "rejected";
export type ApprovalRiskBand = "low" | "medium" | "high" | "catastrophic";
export type ApprovalSubject = "plan" | "phase" | "task";
export type ReviewOutcome =
  | "pending"
  | "approved"
  | "pass"
  | "changes_requested"
  | "blocked"
  | "overridden";
export type CompletionAuditOutcome =
  | "pass"
  | "fail"
  | "changes_requested"
  | "blocked";
export type ArtifactKind =
  | "plan_markdown"
  | "review_report"
  | "completion_audit_report"
  | "completion_evidence_bundle"
  | "test_report"
  | "event_log"
  | "patch_bundle"
  | "pr_summary"
  | "runner_diagnostic"
  | "phase_audit_report"
  | "merge_run_summary"
  | "task_diff"
  | "other";

export interface FileScope {
  includes: string[];
  excludes?: string[];
  packageScopes?: string[];
  maxFiles?: number;
}

export interface AcceptanceCriterion {
  id: string;
  description?: string;
  title?: string;
  verificationCommands?: string[];
  verify?: string;
  required?: boolean;
}

export interface TaskBudget {
  maxWallClockMinutes: number;
  maxModelCostUsd?: number;
  maxPromptTokens?: number;
}

export interface Risk {
  id: string;
  level: RiskLevel;
  title: string;
  description?: string;
  mitigation?: string;
  humanApprovalRequired?: boolean;
}

export interface ContractTask {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  slug: string;
  title: string;
  summary: string;
  kind: TaskKind;
  status: TaskStatus;
  riskLevel: RiskLevel;
  fileScope: FileScope;
  acceptanceCriteria: AcceptanceCriterion[];
  testCommands: string[];
  budget: TaskBudget;
  reviewerPolicy?: unknown;
  requiresHumanApproval?: boolean;
  maxReviewFixCycles?: number;
  branchName?: string;
  worktreePath?: string;
}

export interface ContractPhase {
  id: UUID;
  planId: UUID;
  index: number;
  title: string;
  summary: string;
  status: PhaseStatus;
  integrationBranch: string | null;
  baseSnapshotId?: UUID;
  taskIds?: UUID[];
  mergeOrder?: UUID[];
  phaseAuditReportId?: UUID;
  startedAt?: IsoTimestamp | null;
  completedAt?: IsoTimestamp | null;
}

export interface ContractPlan {
  id: UUID;
  specDocumentId: UUID;
  repoSnapshotId: UUID;
  title: string;
  summary: string;
  status: PlanStatus;
  phases: ContractPhase[];
  tasks: ContractTask[];
  risks: Risk[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentRun {
  id: UUID;
  taskId?: UUID;
  planId?: UUID;
  workflowRunId: string;
  role: string;
  status: string;
  riskLevel?: RiskLevel;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  startedAt?: IsoTimestamp;
  completedAt?: IsoTimestamp;
  errorReason?: string;
}

export interface WorktreeLease {
  id: UUID;
  taskId?: UUID;
  phaseId?: UUID;
  kind?: "task" | "integration";
  repoRoot?: string;
  branchName: string;
  worktreePath: string;
  baseSha: string;
  expiresAt?: IsoTimestamp;
  status?: "active" | "expired" | "released" | "revoked";
}

export interface ReviewReport {
  id: UUID;
  taskId: UUID;
  reviewerRunId?: UUID;
  outcome: ReviewOutcome;
  findings?: unknown[];
  findingsCount?: number;
  summary?: string;
  cycleNumber?: number;
  createdAt?: IsoTimestamp;
  generatedAt?: IsoTimestamp;
}

export interface PolicyDecision {
  id: UUID;
  subjectType: "plan" | "task" | "merge" | "review";
  subjectId: UUID;
  riskLevel: RiskLevel;
  decision: string;
  reason: string;
  actor: "system" | "human";
  createdAt: IsoTimestamp;
}

export interface CompletionAuditReport {
  id: UUID;
  planId: UUID;
  outcome: CompletionAuditOutcome;
  checklist?: unknown[];
  findings?: unknown[];
  summary: unknown;
  createdAt?: IsoTimestamp;
  generatedAt?: IsoTimestamp;
}

export interface MergeRun {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  integrationBranch: string;
  baseSha: string;
  mergedTaskIds: UUID[];
  failedTaskId?: UUID | null;
  integrationHeadSha?: string | null;
  startedAt: IsoTimestamp;
  completedAt?: IsoTimestamp | null;
}

export interface PhaseAuditReport {
  id: UUID;
  phaseId: UUID;
  planId: UUID;
  outcome: "pass" | "changes_requested" | "blocked";
  summary: string;
  createdAt?: IsoTimestamp;
  generatedAt?: IsoTimestamp;
}

export interface ApprovalRequest {
  id: UUID;
  planId: UUID;
  taskId?: UUID;
  phaseId?: UUID;
  subject: ApprovalSubject;
  riskBand: ApprovalRiskBand;
  status: ApprovalStatus;
  requestedBy?: string;
  approvedBy?: string;
  requestedAt: IsoTimestamp;
  decidedAt?: IsoTimestamp;
  reason?: string;
}

export interface BudgetTaskBreakdown {
  taskId: UUID;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
}

export interface BudgetReport {
  id: UUID;
  planId: UUID;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
  perTaskBreakdown: BudgetTaskBreakdown[];
  generatedAt: IsoTimestamp;
}

export type WorkflowEvent =
  | {
      id: UUID;
      planId: UUID;
      kind: "phase_status_changed";
      phaseId: UUID;
      payload: { previousStatus: PhaseStatus; nextStatus: PhaseStatus };
      createdAt: IsoTimestamp;
    }
  | {
      id: UUID;
      planId: UUID;
      kind: "task_status_changed";
      phaseId: UUID;
      taskId: UUID;
      payload: { previousStatus: TaskStatus; nextStatus: TaskStatus };
      createdAt: IsoTimestamp;
    }
  | {
      id: UUID;
      planId: UUID;
      kind: "artifact_persisted";
      payload: { artifactId: UUID; artifactKind: ArtifactKind; uri: string };
      createdAt: IsoTimestamp;
    };

export interface PlanListItem {
  id: UUID;
  title: string;
  summary: string;
  status: PlanStatus;
  risks: Risk[];
  completionAuditReportId: UUID | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PhaseListItem {
  id: UUID;
  planId: UUID;
  index: number;
  title: string;
  summary: string;
  status: PhaseStatus;
  integrationBranch: string | null;
  phaseAuditReportId: UUID | null;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
}

export interface TaskListItem {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  slug: string;
  title: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  kind: TaskKind;
}

export interface PlanDetailPayload {
  plan: ContractPlan;
  artifactIds: UUID[];
  latestCompletionAudit: CompletionAuditReport | null;
}

export interface TaskDetailPayload {
  task?: ContractTask;
  latestAgentRun?: AgentRun | null;
  latestLease?: WorktreeLease | null;
  latestReviewReport?: ReviewReport | null;
  taskPolicyDecisions?: PolicyDecision[];
  reviewSkippedDecision?: PolicyDecision;
}

export interface PhaseDetailPayload {
  phase: ContractPhase;
  latestMergeRun: MergeRun | null;
  latestPhaseAudit: PhaseAuditReport | null;
}

export interface ArtifactFetchPayload {
  id: UUID;
  contentType: string | null;
  body: string | null;
  byteLength?: number;
  error?: RecoverableReadError;
  raw?: unknown;
}

export interface RecoverableReadError {
  status: number;
  message: string;
  body?: unknown;
  requestId?: string;
  raw?: unknown;
}

export type ReadModelState = "ready" | "empty" | "partial" | "error";

export interface Limitation {
  code:
    | "run-list-context-unavailable"
    | "run-list-attention-unavailable"
    | "artifact-metadata-unavailable"
    | "artifact-trusted-open-unavailable"
    | "phase-task-counts-unavailable"
    | "task-approval-state-unavailable"
    | "task-review-state-unavailable"
    | "task-budget-state-unavailable"
    | "task-actions-server-authority"
    | "task-lease-unavailable"
    | "task-policy-decisions-unavailable"
    | "approval-bulk-policy-server-authority"
    | "budget-task-cap-unavailable"
    | "event-subject-context-unavailable"
    | "release-attempt-state-unavailable"
    | "release-artifact-evidence-unavailable"
    | "partial-api-payload"
    | "recoverable-api-error";
  message: string;
  source: string;
  field?: string;
}

export interface LimitedValue<T> {
  value: T | null;
  limitations: Limitation[];
}

export interface ActionAvailability {
  action:
    | "task.run"
    | "task.review"
    | "task.fix"
    | "task.approve"
    | "task.overrideReview"
    | "phase.integrate"
    | "phase.audit"
    | "plan.complete"
    | "plan.release";
  enabled: boolean | null;
  reason: string | null;
  requiresConfirmation: true;
  requiresReason: boolean;
  pending: boolean;
  limitations: Limitation[];
}

export interface ReadModelEnvelope<T, TRaw = unknown> {
  state: ReadModelState;
  data: T;
  limitations: Limitation[];
  errors: RecoverableReadError[];
  raw: TRaw;
}

export interface RunAttention {
  pendingApprovals: LimitedValue<number>;
  blockedTasks: LimitedValue<number>;
  failedTasks: LimitedValue<number>;
  blockedPhases: LimitedValue<number>;
  releaseReady: LimitedValue<boolean>;
}

export interface RunSummaryViewModel {
  id: UUID;
  title: string;
  summary: string;
  status: PlanStatus;
  riskLevels: RiskLevel[];
  hasCompletionAudit: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  attention: RunAttention;
  context: {
    repo: LimitedValue<string>;
    specTitle: LimitedValue<string>;
  };
  raw: PlanListItem;
}

export type TaskCountsByStatus = Partial<Record<TaskStatus, number>>;

export interface PhaseViewModel {
  id: UUID;
  planId: UUID;
  index: number;
  title: string;
  summary: string;
  status: PhaseStatus;
  integrationBranch: string | null;
  phaseAuditReportId: UUID | null;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  taskCountsByStatus: LimitedValue<TaskCountsByStatus>;
  latestMergeRun: MergeRun | null;
  latestPhaseAudit: PhaseAuditReport | null;
  raw: {
    list: PhaseListItem | ContractPhase;
    detail?: PhaseDetailPayload;
  };
}

export interface BudgetSpendViewModel {
  usd: number;
  tokens: number;
  wallClockMinutes: number;
  overBudget: LimitedValue<boolean>;
  capUsd: LimitedValue<number>;
}

export interface TaskSummaryViewModel {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  slug: string;
  title: string;
  status: TaskStatus;
  riskLevel: RiskLevel;
  kind: TaskKind;
  approvalStatus: LimitedValue<ApprovalStatus>;
  reviewState: LimitedValue<ReviewOutcome>;
  branchName: LimitedValue<string>;
  budgetSpend: LimitedValue<BudgetSpendViewModel>;
  availableActions: ActionAvailability[];
  raw: TaskListItem | ContractTask;
}

export interface TaskDetailViewModel extends Omit<TaskSummaryViewModel, "raw"> {
  summary: string;
  fileScope: FileScope;
  acceptanceCriteria: Array<{
    id: string;
    title: string;
    verify: string;
    required: boolean;
  }>;
  testCommands: string[];
  budget: TaskBudget;
  worktreePath: LimitedValue<string>;
  latestAgentRun: LimitedValue<AgentRun>;
  latestLease: LimitedValue<WorktreeLease>;
  latestReviewReport: LimitedValue<ReviewReport>;
  reviewReports: LimitedValue<ReviewReport[]>;
  agentRuns: LimitedValue<AgentRun[]>;
  taskPolicyDecisions: LimitedValue<PolicyDecision[]>;
  reviewSkippedDecision: LimitedValue<PolicyDecision>;
  relatedEvents: LimitedValue<EventItemViewModel[]>;
  relatedArtifacts: LimitedValue<ArtifactSummaryViewModel[]>;
  raw: TaskDetailPayload;
}

export interface ApprovalQueueItemViewModel {
  id: UUID;
  planId: UUID;
  taskId: UUID | null;
  phaseId: UUID | null;
  subject: ApprovalSubject;
  riskBand: ApprovalRiskBand;
  status: ApprovalStatus;
  requestedBy: string | null;
  approvedBy: string | null;
  requestedAt: IsoTimestamp;
  decidedAt: IsoTimestamp | null;
  reason: string | null;
  taskTitle: LimitedValue<string>;
  taskSlug: LimitedValue<string>;
  phaseTitle: LimitedValue<string>;
  isBulkEligible: LimitedValue<boolean>;
  bulkSkippedReason: string | null;
  raw: ApprovalRequest;
}

export interface BudgetSnapshotViewModel {
  id: UUID;
  planId: UUID;
  generatedAt: IsoTimestamp;
  totalUsd: number;
  totalTokens: number;
  totalWallClockMinutes: number;
  perTask: Array<{
    taskId: UUID;
    taskTitle: LimitedValue<string>;
    usd: number;
    tokens: number;
    wallClockMinutes: number;
    overBudget: LimitedValue<boolean>;
    capUsd: LimitedValue<number>;
    raw: BudgetTaskBreakdown;
  }>;
  overBudgetTasks: LimitedValue<UUID[]>;
  raw: BudgetReport;
}

export interface EventItemViewModel {
  id: UUID;
  planId: UUID;
  kind: WorkflowEvent["kind"];
  createdAt: IsoTimestamp;
  phaseId: UUID | null;
  taskId: UUID | null;
  artifactId: UUID | null;
  artifactKind: ArtifactKind | null;
  uri: string | null;
  label: string;
  severity: "info" | "warn" | "error";
  raw: WorkflowEvent;
  limitations: Limitation[];
}

export interface ArtifactSummaryViewModel {
  id: UUID;
  kind: LimitedValue<ArtifactKind>;
  title: LimitedValue<string>;
  planId: UUID;
  taskId: LimitedValue<UUID>;
  phaseId: LimitedValue<UUID>;
  createdAt: LimitedValue<IsoTimestamp>;
  contentType: LimitedValue<string>;
  fetchStatus: "idle" | "loaded" | "errored";
  trustedOpenState: LimitedValue<"validated">;
  body: string | null;
  byteLength: number | null;
  raw: {
    event?: WorkflowEvent;
    fetch?: ArtifactFetchPayload;
  };
}

export interface EvidenceBundleViewModel {
  planId: UUID;
  completionAudit: CompletionAuditReport | null;
  checklist: unknown[];
  findings: unknown[];
  summary: unknown;
  releaseArtifacts: ArtifactSummaryViewModel[];
  artifactContents: ArtifactSummaryViewModel[];
  releaseState:
    | "no_audit"
    | "audit_blocked"
    | "ready_to_release"
    | "release_evidence_present"
    | "unknown";
  raw: {
    planDetail?: PlanDetailPayload;
    events: readonly WorkflowEvent[];
    artifactFetches: readonly ArtifactFetchPayload[];
  };
}

export interface ReleaseReadinessViewModel {
  planId: UUID;
  state:
    | "no_audit"
    | "blocked"
    | "ready_to_release"
    | "release_evidence_present"
    | "unknown";
  completionAuditOutcome: CompletionAuditOutcome | null;
  completionAuditId: UUID | null;
  releaseArtifactIds: UUID[];
  blockers: Array<{ id: string; title: string; message: string }>;
  nextAction: string;
  raw: {
    planDetail?: PlanDetailPayload;
    events: readonly WorkflowEvent[];
  };
  limitations: Limitation[];
}

export interface RunCockpitViewModel {
  planId: UUID;
  title: string;
  summary: string;
  status: PlanStatus;
  currentState: {
    phaseCount: LimitedValue<number>;
    taskCount: LimitedValue<number>;
    taskCountsByStatus: LimitedValue<TaskCountsByStatus>;
    description: string;
  };
  blocker: {
    message: string;
    subjectId: UUID | null;
    subjectType: "plan" | "phase" | "task" | "release" | null;
  };
  nextAction: string;
  release: ReleaseReadinessViewModel;
  attention: RunAttention;
  actions: ActionAvailability[];
  raw: {
    planDetail?: PlanDetailPayload;
    phases?: readonly PhaseListItem[];
    tasks?: readonly TaskListItem[];
    approvals?: readonly ApprovalRequest[];
    budget?: BudgetReport;
    events?: readonly WorkflowEvent[];
  };
}
