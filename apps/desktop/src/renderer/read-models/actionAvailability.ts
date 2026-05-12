import type {
  ActionAvailability,
  ApprovalRequest,
  ApprovalStatus,
  ContractPhase,
  ContractTask,
  Limitation,
  PhaseListItem,
  PhaseStatus,
  PlanStatus,
  ReleaseReadinessViewModel,
  TaskListItem,
  UUID,
} from "./types.js";

type PendingActionKeys = ReadonlySet<string>;

interface AvailabilityBaseInput {
  readonly pendingActionKeys?: PendingActionKeys;
}

export interface BuildTaskActionAvailabilityInput extends AvailabilityBaseInput {
  readonly task: TaskListItem | ContractTask;
  readonly phase: PhaseListItem | ContractPhase | null;
  readonly approvalStatus: ApprovalStatus | null;
}

export interface BuildPhaseActionAvailabilityInput extends AvailabilityBaseInput {
  readonly phase: PhaseListItem | ContractPhase;
  readonly tasks?: readonly (TaskListItem | ContractTask)[];
}

export interface BuildPlanActionAvailabilityInput extends AvailabilityBaseInput {
  readonly planId: UUID;
  readonly planStatus: PlanStatus;
  readonly phases: readonly (PhaseListItem | ContractPhase)[];
  readonly release: ReleaseReadinessViewModel;
  readonly approvals?: readonly ApprovalRequest[];
}

export interface BuildApprovalActionAvailabilityInput extends AvailabilityBaseInput {
  readonly approval: ApprovalRequest;
}

export function actionAvailabilityKey(
  action: ActionAvailability["action"],
  subjectId: UUID,
): string {
  return `${action}:${subjectId}`;
}

export function buildTaskActionAvailability(
  input: BuildTaskActionAvailabilityInput,
): ActionAvailability[] {
  const { task, phase, approvalStatus, pendingActionKeys } = input;
  const serverAuthority = serverAuthorityLimitation("buildTaskActionAvailability");
  const phaseMissing =
    phase === null
      ? [
          limitation(
            "partial-api-payload",
            "Owning phase was not supplied; phase-gated task actions cannot be decided.",
            "buildTaskActionAvailability",
            "phase",
          ),
        ]
      : [];
  return [
    action({
      action: "task.run",
      subjectType: "task",
      subjectId: task.id,
      endpoint: `/tasks/${task.id}/run`,
      enabled:
        phase === null
          ? null
          : phase.status === "executing" &&
            !["running", "ready_to_merge", "merged"].includes(task.status),
      reason:
        phase === null
          ? "Owning phase is unavailable."
          : phase.status === "executing"
            ? null
            : `Owning phase is ${phase.status}.`,
      limitations: [serverAuthority, ...phaseMissing],
      pendingActionKeys,
    }),
    action({
      action: "task.review",
      subjectType: "task",
      subjectId: task.id,
      endpoint: `/tasks/${task.id}/review`,
      enabled: task.status === "in_review",
      reason: task.status === "in_review" ? null : `Task is ${task.status}.`,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
    action({
      action: "task.fix",
      subjectType: "task",
      subjectId: task.id,
      endpoint: `/tasks/${task.id}/fix`,
      enabled: task.status === "fixing",
      reason: task.status === "fixing" ? null : `Task is ${task.status}.`,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
    action({
      action: "task.approve",
      subjectType: "task",
      subjectId: task.id,
      endpoint: `/tasks/${task.id}/approve`,
      enabled: approvalStatus === null ? null : approvalStatus === "pending",
      reason:
        approvalStatus === null
          ? "Approval rows are unavailable."
          : approvalStatus === "pending"
            ? null
            : `Approval is ${approvalStatus}.`,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
    action({
      action: "task.overrideReview",
      subjectType: "task",
      subjectId: task.id,
      endpoint: `/tasks/${task.id}/override-review`,
      enabled: task.status === "blocked" || task.status === "fixing",
      reason:
        task.status === "blocked" || task.status === "fixing"
          ? null
          : `Task is ${task.status}.`,
      requiresReason: true,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
  ];
}

export function buildPhaseActionAvailability(
  input: BuildPhaseActionAvailabilityInput,
): ActionAvailability[] {
  const { phase, tasks, pendingActionKeys } = input;
  const serverAuthority = serverAuthorityLimitation("buildPhaseActionAvailability");
  const taskReadiness =
    tasks === undefined
      ? null
      : tasks.every((task) => task.status === "ready_to_merge" || task.status === "merged");
  const taskLimitations =
    tasks === undefined
      ? [
          limitation(
            "phase-task-counts-unavailable",
            "Phase task rows were not supplied; integration readiness cannot be decided locally.",
            "buildPhaseActionAvailability",
            "tasks",
          ),
        ]
      : [];

  return [
    action({
      action: "phase.integrate",
      subjectType: "phase",
      subjectId: phase.id,
      endpoint: `/phases/${phase.id}/integrate`,
      enabled:
        taskReadiness === null
          ? null
          : (phase.status === "executing" || phase.status === "integrating") &&
            taskReadiness,
      reason: phaseIntegrationReason(phase.status, taskReadiness),
      limitations: [serverAuthority, ...taskLimitations],
      pendingActionKeys,
    }),
    action({
      action: "phase.audit",
      subjectType: "phase",
      subjectId: phase.id,
      endpoint: `/phases/${phase.id}/audit`,
      enabled: phase.status === "auditing",
      reason: phase.status === "auditing" ? null : `Phase is ${phase.status}.`,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
    action({
      action: "phase.overrideAudit",
      subjectType: "phase",
      subjectId: phase.id,
      endpoint: `/phases/${phase.id}/override-audit`,
      enabled: phase.status === "blocked",
      reason: phase.status === "blocked" ? null : `Phase is ${phase.status}.`,
      requiresReason: true,
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
  ];
}

export function buildPlanActionAvailability(
  input: BuildPlanActionAvailabilityInput,
): ActionAvailability[] {
  const { planId, phases, release, approvals, pendingActionKeys } = input;
  const serverAuthority = serverAuthorityLimitation("buildPlanActionAvailability");
  const allPhasesCompleted =
    phases.length > 0 && phases.every((phase) => phase.status === "completed");
  const pendingPlanApproval =
    approvals?.some((row) => row.subject === "plan" && row.status === "pending") ??
    null;
  const pendingAnyApproval =
    approvals?.some((row) => row.status === "pending") ?? null;
  const approvalLimitations =
    approvals === undefined
      ? [
          limitation(
            "approval-bulk-policy-server-authority",
            "Approval rows were not supplied; approval actions are API-authoritative.",
            "buildPlanActionAvailability",
            "approvals",
          ),
        ]
      : [];

  return [
    action({
      action: "plan.approve",
      subjectType: "plan",
      subjectId: planId,
      endpoint: `/plans/${planId}/approve`,
      enabled: pendingPlanApproval,
      reason:
        pendingPlanApproval === null
          ? "Approval rows are unavailable."
          : pendingPlanApproval
            ? null
            : "No pending plan-scoped approval exists.",
      limitations: [serverAuthority, ...approvalLimitations],
      pendingActionKeys,
    }),
    action({
      action: "plan.approveAllPending",
      subjectType: "plan",
      subjectId: planId,
      endpoint: `/plans/${planId}/approve-all-pending`,
      enabled: pendingAnyApproval,
      reason:
        pendingAnyApproval === null
          ? "Approval rows are unavailable."
          : pendingAnyApproval
            ? null
            : "No pending approvals exist.",
      requiresReason: true,
      limitations: [serverAuthority, ...approvalLimitations],
      pendingActionKeys,
    }),
    action({
      action: "plan.complete",
      subjectType: "plan",
      subjectId: planId,
      endpoint: `/plans/${planId}/complete`,
      enabled: allPhasesCompleted,
      reason: allPhasesCompleted ? null : "Not every phase is completed.",
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
    action({
      action: "plan.release",
      subjectType: "plan",
      subjectId: planId,
      endpoint: `/plans/${planId}/release`,
      enabled: release.state === "ready_to_release",
      reason:
        release.state === "ready_to_release"
          ? null
          : release.state === "release_evidence_present"
            ? "Release evidence already exists."
            : "Completion audit is not ready for release.",
      limitations: [serverAuthority],
      pendingActionKeys,
    }),
  ];
}

export function buildApprovalActionAvailability(
  input: BuildApprovalActionAvailabilityInput,
): ActionAvailability[] {
  const { approval, pendingActionKeys } = input;
  const serverAuthority = serverAuthorityLimitation("buildApprovalActionAvailability");
  const endpoint =
    approval.subject === "task" && approval.taskId !== undefined
      ? `/tasks/${approval.taskId}/approve`
      : `/plans/${approval.planId}/approve`;
  const subjectId =
    approval.subject === "task" && approval.taskId !== undefined
      ? approval.taskId
      : approval.planId;
  const actionKind =
    approval.subject === "task" ? "task.approve" : "plan.approve";

  return [
    action({
      action: actionKind,
      subjectType: "approval",
      subjectId: approval.id,
      endpoint,
      enabled: approval.status === "pending",
      reason:
        approval.status === "pending"
          ? null
          : `Approval is ${approval.status}.`,
      limitations: [serverAuthority],
      pendingActionKeys,
      pendingSubjectId: subjectId,
    }),
  ];
}

function phaseIntegrationReason(
  phaseStatus: PhaseStatus,
  taskReadiness: boolean | null,
): string | null {
  if (taskReadiness === null) return "Phase task readiness is unavailable.";
  if (phaseStatus !== "executing" && phaseStatus !== "integrating") {
    return `Phase is ${phaseStatus}.`;
  }
  if (!taskReadiness) {
    return "Not every task is ready_to_merge or merged.";
  }
  return null;
}

function action(input: {
  readonly action: ActionAvailability["action"];
  readonly subjectType: ActionAvailability["subjectType"];
  readonly subjectId: UUID;
  readonly endpoint: string;
  readonly enabled: boolean | null;
  readonly reason: string | null;
  readonly limitations: readonly Limitation[];
  readonly pendingActionKeys?: PendingActionKeys | undefined;
  readonly pendingSubjectId?: UUID | undefined;
  readonly requiresReason?: boolean | undefined;
}): ActionAvailability {
  const pendingKey = actionAvailabilityKey(
    input.action,
    input.pendingSubjectId ?? input.subjectId,
  );
  return {
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    method: "POST",
    endpoint: input.endpoint,
    enabled: input.enabled,
    reason: input.reason,
    requiresConfirmation: true,
    requiresReason: input.requiresReason ?? false,
    pending: input.pendingActionKeys?.has(pendingKey) ?? false,
    limitations: uniqueLimitations(input.limitations),
  };
}

function serverAuthorityLimitation(source: string): Limitation {
  return limitation(
    "task-actions-server-authority",
    "Desktop mirrors shallow action gates; API mutations remain authoritative.",
    source,
    "availableActions",
  );
}

function limitation(
  code: Limitation["code"],
  message: string,
  source: string,
  field?: string,
): Limitation {
  return field === undefined ? { code, message, source } : { code, message, source, field };
}

function uniqueLimitations(limitations: readonly Limitation[]): Limitation[] {
  const seen = new Set<string>();
  const out: Limitation[] = [];
  for (const item of limitations) {
    const key = `${item.code}:${item.source}:${item.field ?? ""}:${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
