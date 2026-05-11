/**
 * Desktop live read-model types.
 *
 * The API returns a mix of canonical pm-go contract objects and narrow
 * endpoint projections. Canonical shapes are imported from
 * `@pm-go/contracts`; only route-specific projections and UI view models
 * live here.
 */

import type {
  AcceptanceCriterion,
  AgentRun,
  ApprovalRequest,
  ApprovalRiskBand,
  ApprovalStatus,
  ApprovalSubject,
  Artifact,
  BudgetReport,
  BudgetTaskBreakdown,
  CompletionAuditOutcome,
  CompletionAuditReport,
  FileScope,
  MergeRun,
  Phase as ContractPhase,
  PhaseAuditReport,
  PhaseStatus,
  Plan as ContractPlan,
  PlanStatus,
  PolicyDecision,
  ReviewOutcome,
  ReviewReport,
  Risk,
  RiskLevel,
  Task as ContractTask,
  TaskBudget,
  TaskKind,
  TaskStatus,
  UUID,
  WorkflowEvent,
  WorktreeLease,
} from "@pm-go/contracts";

export type {
  AcceptanceCriterion,
  AgentRun,
  ApprovalRequest,
  ApprovalRiskBand,
  ApprovalStatus,
  ApprovalSubject,
  BudgetReport,
  BudgetTaskBreakdown,
  CompletionAuditOutcome,
  CompletionAuditReport,
  FileScope,
  PhaseStatus,
  PlanStatus,
  PolicyDecision,
  ReviewOutcome,
  ReviewReport,
  Risk,
  RiskLevel,
  TaskBudget,
  TaskKind,
  TaskStatus,
  UUID,
  WorkflowEvent,
  WorktreeLease,
} from "@pm-go/contracts";
export type {
  MergeRun as ContractMergeRun,
  Phase as ContractPhase,
  Plan as ContractPlan,
  Task as ContractTask,
} from "@pm-go/contracts";

export type IsoTimestamp = string;
export type ArtifactKind = Artifact["kind"];
export type TaskReviewState = ReviewOutcome | "pending";

export type ReviewReportProjection = ReviewReport & {
  cycleNumber?: number;
};

export type MergeRunProjection = Omit<
  MergeRun,
  "failedTaskId" | "integrationHeadSha" | "completedAt"
> & {
  failedTaskId?: UUID | null;
  integrationHeadSha?: string | null;
  postMergeSnapshotId?: UUID | null;
  integrationLeaseId?: UUID | null;
  completedAt?: IsoTimestamp | null;
};

export type PhaseAuditReportProjection = PhaseAuditReport & {
  overrideReason?: string;
  overriddenBy?: string;
  overriddenAt?: IsoTimestamp;
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
  latestMergeRun: MergeRunProjection | null;
  latestPhaseAudit: PhaseAuditReportProjection | null;
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
  latestMergeRun: MergeRunProjection | null;
  latestPhaseAudit: PhaseAuditReportProjection | null;
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
  reviewState: LimitedValue<TaskReviewState>;
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
  reviewReports: LimitedValue<ReviewReportProjection[]>;
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
