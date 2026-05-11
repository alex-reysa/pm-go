export type {
  AcceptanceCriterion,
  ActionAvailability,
  AgentRun,
  ApprovalQueueItemViewModel,
  ApprovalRequest,
  ArtifactFetchPayload,
  ArtifactKind,
  ArtifactSummaryViewModel,
  BudgetReport,
  BudgetSnapshotViewModel,
  CompletionAuditReport,
  ContractPhase,
  ContractPlan,
  ContractTask,
  EventItemViewModel,
  EvidenceBundleViewModel,
  FileScope,
  LimitedValue,
  Limitation,
  PhaseDetailPayload,
  PhaseListItem,
  PhaseViewModel,
  PlanDetailPayload,
  PlanListItem,
  ReadModelEnvelope,
  RecoverableReadError,
  ReleaseReadinessViewModel,
  ReviewReport,
  RunCockpitViewModel,
  RunSummaryViewModel,
  TaskDetailPayload,
  TaskDetailViewModel,
  TaskListItem,
  TaskSummaryViewModel,
  WorkflowEvent,
} from "./types.js";

import type {
  AcceptanceCriterion,
  ActionAvailability,
  AgentRun,
  ApprovalQueueItemViewModel,
  ApprovalRequest,
  ApprovalStatus,
  ArtifactFetchPayload,
  ArtifactKind,
  ArtifactSummaryViewModel,
  BudgetReport,
  BudgetSnapshotViewModel,
  BudgetSpendViewModel,
  BudgetTaskBreakdown,
  CompletionAuditOutcome,
  ContractPhase,
  ContractTask,
  EventItemViewModel,
  EvidenceBundleViewModel,
  LimitedValue,
  Limitation,
  PhaseDetailPayload,
  PhaseListItem,
  PhaseStatus,
  PhaseViewModel,
  PlanDetailPayload,
  PlanListItem,
  ReadModelEnvelope,
  RecoverableReadError,
  ReleaseReadinessViewModel,
  ReviewOutcome,
  ReviewReport,
  RunAttention,
  RunCockpitViewModel,
  RunSummaryViewModel,
  TaskCountsByStatus,
  TaskDetailPayload,
  TaskDetailViewModel,
  TaskListItem,
  TaskStatus,
  TaskSummaryViewModel,
  UUID,
  WorkflowEvent,
} from "./types.js";

export interface BuildRunSummariesInput {
  readonly plans?: readonly PlanListItem[];
  readonly cockpitByPlanId?: ReadonlyMap<UUID, RunCockpitViewModel>;
  readonly error?: RecoverableReadError;
}

export interface BuildRunCockpitInput {
  readonly planDetail?: PlanDetailPayload;
  readonly phases?: readonly PhaseListItem[];
  readonly tasks?: readonly TaskListItem[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly budget?: BudgetReport;
  readonly events?: readonly WorkflowEvent[];
  readonly error?: RecoverableReadError;
}

export interface BuildPhasesInput {
  readonly planDetail?: PlanDetailPayload;
  readonly phases?: readonly PhaseListItem[];
  readonly tasks?: readonly TaskListItem[];
  readonly phaseDetails?: ReadonlyMap<UUID, PhaseDetailPayload>;
  readonly error?: RecoverableReadError;
}

export interface BuildTaskSummariesInput {
  readonly tasks?: readonly TaskListItem[];
  readonly phases?: readonly PhaseListItem[];
  readonly approvals?: readonly ApprovalRequest[];
  readonly budget?: BudgetReport;
  readonly taskDetails?: ReadonlyMap<UUID, TaskDetailPayload>;
  readonly error?: RecoverableReadError;
}

export interface BuildTaskDetailInput {
  readonly payload?: TaskDetailPayload;
  readonly phase?: PhaseListItem | ContractPhase;
  readonly approvals?: readonly ApprovalRequest[];
  readonly budget?: BudgetReport;
  readonly reviewReports?: readonly ReviewReport[];
  readonly agentRuns?: readonly AgentRun[];
  readonly relatedEvents?: readonly EventItemViewModel[];
  readonly relatedArtifacts?: readonly ArtifactSummaryViewModel[];
  readonly error?: RecoverableReadError;
}

export interface BuildApprovalsInput {
  readonly approvals?: readonly ApprovalRequest[];
  readonly tasks?: readonly TaskSummaryViewModel[] | readonly TaskListItem[];
  readonly phases?: readonly PhaseViewModel[] | readonly PhaseListItem[];
  readonly bulkSkippedReasons?: ReadonlyMap<UUID, string>;
  readonly error?: RecoverableReadError;
}

export interface BuildBudgetSnapshotInput {
  readonly budget?: BudgetReport;
  readonly tasks?: readonly TaskSummaryViewModel[] | readonly TaskListItem[];
  readonly taskDetails?: ReadonlyMap<UUID, TaskDetailPayload>;
  readonly error?: RecoverableReadError;
}

export interface BuildEventReplayInput {
  readonly events?: readonly WorkflowEvent[];
  readonly phases?: readonly PhaseViewModel[] | readonly PhaseListItem[];
  readonly tasks?: readonly TaskSummaryViewModel[] | readonly TaskListItem[];
  readonly error?: RecoverableReadError;
}

export interface BuildArtifactEvidenceInput {
  readonly planId: UUID;
  readonly artifactIds?: readonly UUID[];
  readonly events?: readonly WorkflowEvent[];
  readonly fetches?: readonly ArtifactFetchPayload[];
  readonly planDetail?: PlanDetailPayload;
  readonly error?: RecoverableReadError;
}

export interface BuildReleaseReadinessInput {
  readonly planId: UUID;
  readonly planDetail?: PlanDetailPayload;
  readonly events?: readonly WorkflowEvent[];
  readonly error?: RecoverableReadError;
}

export function buildRunSummaries(
  input: BuildRunSummariesInput,
): ReadModelEnvelope<RunSummaryViewModel[], readonly PlanListItem[]> {
  const plans = input.plans ?? [];
  const errors = compact([input.error]);
  const data = plans.map((plan) => runSummaryFromPlan(plan, input.cockpitByPlanId));
  const limitations = uniqueLimitations(data.flatMap((run) => [
    ...run.context.repo.limitations,
    ...run.context.specTitle.limitations,
    ...attentionLimitations(run.attention),
  ]));

  return {
    state: stateForCollection(data.length, errors.length, input.plans !== undefined),
    data,
    limitations,
    errors,
    raw: plans,
  };
}

export function buildRunCockpit(
  input: BuildRunCockpitInput,
): ReadModelEnvelope<RunCockpitViewModel | null, BuildRunCockpitInput> {
  const errors = compact([input.error]);
  if (input.planDetail === undefined) {
    return {
      state: errors.length > 0 ? "error" : "empty",
      data: null,
      limitations: errors.map(errorLimitation),
      errors,
      raw: input,
    };
  }

  const plan = input.planDetail.plan;
  const phases = input.phases ?? phasesFromPlan(plan);
  const tasks = input.tasks ?? tasksFromPlan(plan);
  const release = buildReleaseReadiness({
    planId: plan.id,
    planDetail: input.planDetail,
    ...(input.events !== undefined ? { events: input.events } : {}),
  }).data;
  const phaseCount = limited(
    phases.length,
    input.phases === undefined && plan.phases.length === 0
      ? [
          limitation(
            "phase-task-counts-unavailable",
            "GET /plans/:id did not carry phases and GET /phases was not supplied.",
            "buildRunCockpit",
            "currentState.phaseCount",
          ),
        ]
      : [],
  );
  const taskCounts = countTasksByStatus(tasks);
  const taskCount = limited(
    tasks.length,
    input.tasks === undefined && plan.tasks.length === 0
      ? [
          limitation(
            "phase-task-counts-unavailable",
            "GET /plans/:id did not carry tasks and GET /tasks was not supplied.",
            "buildRunCockpit",
            "currentState.taskCount",
          ),
        ]
      : [],
  );
  const taskCountsValue = limited<TaskCountsByStatus>(
    taskCounts,
    taskCount.limitations,
  );
  const attention = buildAttention({
    approvals: input.approvals,
    phases,
    tasks,
    release,
  });
  const blocker = describeBlocker(plan.status, phases, tasks, release);
  const actions = buildPlanActions(plan.status, phases, release);
  const limitations = uniqueLimitations([
    ...phaseCount.limitations,
    ...taskCount.limitations,
    ...taskCountsValue.limitations,
    ...release.limitations,
    ...attentionLimitations(attention),
    ...actions.flatMap((action) => action.limitations),
    ...errors.map(errorLimitation),
  ]);

  return {
    state: errors.length > 0 || limitations.length > 0 ? "partial" : "ready",
    data: {
      planId: plan.id,
      title: plan.title,
      summary: plan.summary,
      status: plan.status,
      currentState: {
        phaseCount,
        taskCount,
        taskCountsByStatus: taskCountsValue,
        description: describePlanStatus(plan.status),
      },
      blocker,
      nextAction: describeNextAction(plan.status, release),
      release,
      attention,
      actions,
      raw: {
        planDetail: input.planDetail,
        ...(input.phases !== undefined ? { phases: input.phases } : {}),
        ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
        ...(input.approvals !== undefined ? { approvals: input.approvals } : {}),
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
      },
    },
    limitations,
    errors,
    raw: input,
  };
}

export function buildPhases(
  input: BuildPhasesInput,
): ReadModelEnvelope<PhaseViewModel[], readonly PhaseListItem[] | readonly ContractPhase[]> {
  const rawPhases = input.phases ?? (input.planDetail?.plan.phases ?? []);
  const taskCountsByPhase = input.tasks === undefined ? null : countTasksByPhase(input.tasks);
  const data = rawPhases.map((phase) => {
    const detail = input.phaseDetails?.get(phase.id);
    const countLimitations =
      taskCountsByPhase === null
        ? [
            limitation(
              "phase-task-counts-unavailable",
              "GET /phases does not include task counts; provide GET /tasks to derive them.",
              "buildPhases",
              "taskCountsByStatus",
            ),
          ]
        : [];
    return {
      id: phase.id,
      planId: phase.planId,
      index: phase.index,
      title: phase.title,
      summary: phase.summary,
      status: phase.status,
      integrationBranch: phase.integrationBranch,
      phaseAuditReportId: phaseAuditId(phase),
      startedAt: nullableIso(phase.startedAt),
      completedAt: nullableIso(phase.completedAt),
      taskCountsByStatus: limited(taskCountsByPhase?.get(phase.id) ?? {}, countLimitations),
      latestMergeRun: detail?.latestMergeRun ?? null,
      latestPhaseAudit: detail?.latestPhaseAudit ?? null,
      raw: detail === undefined ? { list: phase } : { list: phase, detail },
    };
  });
  const errors = compact([input.error]);
  const limitations = uniqueLimitations(
    data.flatMap((phase) => phase.taskCountsByStatus.limitations),
  );

  return {
    state: stateForCollection(data.length, errors.length, rawPhases.length > 0),
    data,
    limitations: uniqueLimitations([...limitations, ...errors.map(errorLimitation)]),
    errors,
    raw: rawPhases,
  };
}

export function buildTaskSummaries(
  input: BuildTaskSummariesInput,
): ReadModelEnvelope<TaskSummaryViewModel[], readonly TaskListItem[]> {
  const tasks = input.tasks ?? [];
  const phaseById = mapById(input.phases ?? []);
  const budgetByTask = budgetBreakdownByTask(input.budget);
  const data = tasks.map((task) =>
    buildTaskSummary(task, {
      phase: phaseById.get(task.phaseId) ?? null,
      approvals: input.approvals,
      budgetRow: budgetByTask.get(task.id) ?? null,
      detailPayload: input.taskDetails?.get(task.id),
      budgetAvailable: input.budget !== undefined,
    }),
  );
  const errors = compact([input.error]);
  const limitations = uniqueLimitations([
    ...data.flatMap(taskSummaryLimitations),
    ...errors.map(errorLimitation),
  ]);

  return {
    state: stateForCollection(data.length, errors.length, input.tasks !== undefined),
    data,
    limitations,
    errors,
    raw: tasks,
  };
}

export function buildTaskDetail(
  input: BuildTaskDetailInput,
): ReadModelEnvelope<TaskDetailViewModel | null, TaskDetailPayload | null> {
  const errors = compact([input.error]);
  const payload = input.payload;
  if (payload?.task === undefined) {
    const limitations = uniqueLimitations([
      ...errors.map(errorLimitation),
      ...(payload === undefined
        ? [
            limitation(
              "partial-api-payload",
              "Task detail payload is missing.",
              "buildTaskDetail",
              "payload",
            ),
          ]
        : []),
    ]);
    return {
      state: errors.length > 0 ? "error" : "empty",
      data: null,
      limitations,
      errors,
      raw: payload ?? null,
    };
  }

  const task = payload.task;
  const summary = buildTaskSummary(task, {
    phase: input.phase ?? null,
    approvals: input.approvals,
    budgetRow: budgetBreakdownByTask(input.budget).get(task.id) ?? null,
    detailPayload: payload,
    budgetAvailable: input.budget !== undefined,
  });
  const latestLease = fieldValue(payload, "latestLease", "task-lease-unavailable", "latestLease");
  const latestAgentRun = fieldValue(payload, "latestAgentRun", "partial-api-payload", "latestAgentRun");
  const latestReviewReport = fieldValue(
    payload,
    "latestReviewReport",
    "task-review-state-unavailable",
    "latestReviewReport",
  );
  const policyDecisions = arrayFieldValue(
    payload,
    "taskPolicyDecisions",
    "task-policy-decisions-unavailable",
    "taskPolicyDecisions",
  );
  const reviewSkippedDecision = fieldValue(
    payload,
    "reviewSkippedDecision",
    "task-policy-decisions-unavailable",
    "reviewSkippedDecision",
  );
  const reviewReports = input.reviewReports === undefined
    ? limited<ReviewReport[]>(null, [
        limitation(
          "task-review-state-unavailable",
          "Review history was not supplied; only inline latest review can be shown.",
          "buildTaskDetail",
          "reviewReports",
        ),
      ])
    : limited([...input.reviewReports]);
  const agentRuns = input.agentRuns === undefined
    ? limited<AgentRun[]>(null, [
        limitation(
          "partial-api-payload",
          "Agent run history was not supplied; only inline latest agent run can be shown.",
          "buildTaskDetail",
          "agentRuns",
        ),
      ])
    : limited([...input.agentRuns]);
  const relatedEvents = input.relatedEvents === undefined
    ? limited<EventItemViewModel[]>(null, [
        limitation(
          "event-subject-context-unavailable",
          "Related event replay was not supplied for this task detail.",
          "buildTaskDetail",
          "relatedEvents",
        ),
      ])
    : limited([...input.relatedEvents]);
  const relatedArtifacts = input.relatedArtifacts === undefined
    ? limited<ArtifactSummaryViewModel[]>(null, [
        limitation(
          "artifact-metadata-unavailable",
          "Related artifacts cannot be proven without artifact metadata or artifact events.",
          "buildTaskDetail",
          "relatedArtifacts",
        ),
      ])
    : limited([...input.relatedArtifacts]);

  const latestLeaseValue = latestLease.value;
  const worktreePath = latestLeaseValue?.worktreePath ?? task.worktreePath ?? null;
  const worktreeLimitations = worktreePath === null && !hasOwn(payload, "latestLease")
    ? latestLease.limitations
    : [];
  const limitations = uniqueLimitations([
    ...taskSummaryLimitations(summary),
    ...latestLease.limitations,
    ...latestAgentRun.limitations,
    ...latestReviewReport.limitations,
    ...policyDecisions.limitations,
    ...reviewSkippedDecision.limitations,
    ...reviewReports.limitations,
    ...agentRuns.limitations,
    ...relatedEvents.limitations,
    ...relatedArtifacts.limitations,
    ...worktreeLimitations,
    ...errors.map(errorLimitation),
  ]);

  return {
    state: errors.length > 0 || limitations.length > 0 ? "partial" : "ready",
    data: {
      ...summary,
      summary: task.summary,
      fileScope: {
        includes: [...task.fileScope.includes],
        ...(task.fileScope.excludes !== undefined
          ? { excludes: [...task.fileScope.excludes] }
          : {}),
        ...(task.fileScope.packageScopes !== undefined
          ? { packageScopes: [...task.fileScope.packageScopes] }
          : {}),
        ...(task.fileScope.maxFiles !== undefined
          ? { maxFiles: task.fileScope.maxFiles }
          : {}),
      },
      acceptanceCriteria: task.acceptanceCriteria.map(normalizeAcceptanceCriterion),
      testCommands: [...task.testCommands],
      budget: { ...task.budget },
      worktreePath: limited(worktreePath, worktreeLimitations),
      latestAgentRun,
      latestLease,
      latestReviewReport,
      reviewReports,
      agentRuns,
      taskPolicyDecisions: policyDecisions,
      reviewSkippedDecision,
      relatedEvents,
      relatedArtifacts,
      raw: payload,
    },
    limitations,
    errors,
    raw: payload,
  };
}

export function buildApprovals(
  input: BuildApprovalsInput,
): ReadModelEnvelope<ApprovalQueueItemViewModel[], readonly ApprovalRequest[]> {
  const approvals = input.approvals ?? [];
  const taskById = mapTaskLikeById(input.tasks ?? []);
  const phaseById = mapPhaseLikeById(input.phases ?? []);
  const data = approvals.map((approval) => {
    const task = approval.taskId === undefined ? undefined : taskById.get(approval.taskId);
    const phaseId = approval.phaseId ?? task?.phaseId;
    const phase = phaseId === undefined ? undefined : phaseById.get(phaseId);
    const bulkLimitation = limitation(
      "approval-bulk-policy-server-authority",
      "Desktop does not duplicate bulk-approval safety policy; the API decides eligibility.",
      "buildApprovals",
      "isBulkEligible",
    );
    return {
      id: approval.id,
      planId: approval.planId,
      taskId: approval.taskId ?? null,
      phaseId: phaseId ?? null,
      subject: approval.subject,
      riskBand: approval.riskBand,
      status: approval.status,
      requestedBy: approval.requestedBy ?? null,
      approvedBy: approval.approvedBy ?? null,
      requestedAt: approval.requestedAt,
      decidedAt: approval.decidedAt ?? null,
      reason: approval.reason ?? null,
      taskTitle: task === undefined
        ? limited<string>(null, [
            limitation(
              "partial-api-payload",
              "Approval row lacks joined task title; provide task read models to fill it.",
              "buildApprovals",
              "taskTitle",
            ),
          ])
        : limited(task.title),
      taskSlug: task === undefined
        ? limited<string>(null, [
            limitation(
              "partial-api-payload",
              "Approval row lacks joined task slug; provide task read models to fill it.",
              "buildApprovals",
              "taskSlug",
            ),
          ])
        : limited(task.slug),
      phaseTitle: phase === undefined
        ? limited<string>(null, [
            limitation(
              "partial-api-payload",
              "Approval row lacks joined phase title; provide phase read models to fill it.",
              "buildApprovals",
              "phaseTitle",
            ),
          ])
        : limited(phase.title),
      isBulkEligible: limited<boolean>(null, [bulkLimitation]),
      bulkSkippedReason: input.bulkSkippedReasons?.get(approval.id) ?? null,
      raw: approval,
    };
  });
  const errors = compact([input.error]);
  const limitations = uniqueLimitations([
    ...data.flatMap((approval) => [
      ...approval.taskTitle.limitations,
      ...approval.taskSlug.limitations,
      ...approval.phaseTitle.limitations,
      ...approval.isBulkEligible.limitations,
    ]),
    ...errors.map(errorLimitation),
  ]);
  return {
    state: stateForCollection(data.length, errors.length, input.approvals !== undefined),
    data,
    limitations,
    errors,
    raw: approvals,
  };
}

export function buildBudgetSnapshot(
  input: BuildBudgetSnapshotInput,
): ReadModelEnvelope<BudgetSnapshotViewModel | null, BudgetReport | null> {
  const errors = compact([input.error]);
  if (input.budget === undefined) {
    return {
      state: errors.length > 0 ? "error" : "empty",
      data: null,
      limitations: errors.map(errorLimitation),
      errors,
      raw: null,
    };
  }

  const taskById = mapTaskLikeById(input.tasks ?? []);
  const perTask = input.budget.perTaskBreakdown.map((row) => {
    const task = taskById.get(row.taskId);
    const detail = input.taskDetails?.get(row.taskId)?.task;
    const capUsd = detail?.budget.maxModelCostUsd ?? taskBudgetCap(task);
    const capLimitations =
      capUsd === null
        ? [
            limitation(
              "budget-task-cap-unavailable",
              "Budget report does not include task caps; provide task detail to compute over-budget state.",
              "buildBudgetSnapshot",
              "capUsd",
            ),
          ]
        : [];
    return {
      taskId: row.taskId,
      taskTitle: task === undefined
        ? limited<string>(null, [
            limitation(
              "partial-api-payload",
              "Budget row lacks task title; provide task read models to fill it.",
              "buildBudgetSnapshot",
              "taskTitle",
            ),
          ])
        : limited(task.title),
      usd: row.totalUsd,
      tokens: row.totalTokens,
      wallClockMinutes: row.totalWallClockMinutes,
      overBudget: limited(
        capUsd === null ? null : row.totalUsd >= capUsd,
        capLimitations,
      ),
      capUsd: limited(capUsd, capLimitations),
      raw: row,
    };
  });
  const overBudgetLimitations = perTask.flatMap((row) => row.overBudget.limitations);
  const overBudgetTasks = overBudgetLimitations.length > 0
    ? limited<UUID[]>(null, overBudgetLimitations)
    : limited(perTask.filter((row) => row.overBudget.value === true).map((row) => row.taskId));
  const data = {
    id: input.budget.id,
    planId: input.budget.planId,
    generatedAt: input.budget.generatedAt,
    totalUsd: input.budget.totalUsd,
    totalTokens: input.budget.totalTokens,
    totalWallClockMinutes: input.budget.totalWallClockMinutes,
    perTask,
    overBudgetTasks,
    raw: input.budget,
  };
  const limitations = uniqueLimitations([
    ...perTask.flatMap((row) => [
      ...row.taskTitle.limitations,
      ...row.overBudget.limitations,
      ...row.capUsd.limitations,
    ]),
    ...overBudgetTasks.limitations,
    ...errors.map(errorLimitation),
  ]);

  return {
    state: errors.length > 0 || limitations.length > 0 ? "partial" : "ready",
    data,
    limitations,
    errors,
    raw: input.budget,
  };
}

export function buildEventReplay(
  input: BuildEventReplayInput,
): ReadModelEnvelope<EventItemViewModel[], readonly WorkflowEvent[]> {
  const events = input.events ?? [];
  const phaseById = mapPhaseLikeById(input.phases ?? []);
  const taskById = mapTaskLikeById(input.tasks ?? []);
  const data = events.map((event) => eventItemFromWorkflowEvent(event, phaseById, taskById));
  const errors = compact([input.error]);
  const limitations = uniqueLimitations([
    ...data.flatMap((event) => event.limitations),
    ...errors.map(errorLimitation),
  ]);
  return {
    state: stateForCollection(data.length, errors.length, input.events !== undefined),
    data,
    limitations,
    errors,
    raw: events,
  };
}

export function buildArtifactEvidence(
  input: BuildArtifactEvidenceInput,
): ReadModelEnvelope<EvidenceBundleViewModel, BuildArtifactEvidenceInput> {
  const events = input.events ?? [];
  const artifactIds = input.artifactIds ?? input.planDetail?.artifactIds ?? [];
  const fetches = input.fetches ?? [];
  const eventByArtifactId = artifactEventsById(events);
  const fetchById = new Map(fetches.map((fetch) => [fetch.id, fetch]));
  const releaseArtifactIds = new Set<UUID>();
  const allIds = new Set<UUID>(artifactIds);
  for (const [id, event] of eventByArtifactId) {
    allIds.add(id);
    if (isReleaseArtifactKind(event.payload.artifactKind)) {
      releaseArtifactIds.add(id);
    }
  }

  const artifacts = [...allIds].map((id) =>
    artifactSummaryFromSources(input.planId, id, eventByArtifactId.get(id), fetchById.get(id)),
  );
  const releaseArtifacts = artifacts.filter((artifact) => releaseArtifactIds.has(artifact.id));
  const completionAudit = input.planDetail?.latestCompletionAudit ?? null;
  const evidence: EvidenceBundleViewModel = {
    planId: input.planId,
    completionAudit,
    checklist: Array.isArray(completionAudit?.checklist) ? completionAudit.checklist : [],
    findings: Array.isArray(completionAudit?.findings) ? completionAudit.findings : [],
    summary: completionAudit?.summary ?? null,
    releaseArtifacts,
    artifactContents: artifacts.filter((artifact) => artifact.fetchStatus === "loaded"),
    releaseState: evidenceReleaseState(completionAudit?.outcome ?? null, releaseArtifacts.length),
    raw: {
      ...(input.planDetail !== undefined ? { planDetail: input.planDetail } : {}),
      events,
      artifactFetches: fetches,
    },
  };
  const errors = compact([input.error, ...fetches.map((fetch) => fetch.error)]);
  const limitations = uniqueLimitations([
    ...artifacts.flatMap(artifactLimitations),
    ...(releaseArtifacts.length === 0 && completionAudit?.outcome === "pass"
      ? [
          limitation(
            "release-artifact-evidence-unavailable",
            "No durable release artifact events were supplied for the passing completion audit.",
            "buildArtifactEvidence",
            "releaseArtifacts",
          ),
        ]
      : []),
    ...errors.map(errorLimitation),
  ]);

  return {
    state: errors.length > 0 || limitations.length > 0 ? "partial" : "ready",
    data: evidence,
    limitations,
    errors,
    raw: input,
  };
}

export function buildReleaseReadiness(
  input: BuildReleaseReadinessInput,
): ReadModelEnvelope<ReleaseReadinessViewModel, BuildReleaseReadinessInput> {
  const events = input.events ?? [];
  const releaseArtifactIds = events
    .filter((event): event is Extract<WorkflowEvent, { kind: "artifact_persisted" }> =>
      event.kind === "artifact_persisted" && isReleaseArtifactKind(event.payload.artifactKind),
    )
    .map((event) => event.payload.artifactId);
  const audit = input.planDetail?.latestCompletionAudit ?? null;
  const errors = compact([input.error]);
  const limitations: Limitation[] = [
    limitation(
      "release-attempt-state-unavailable",
      "Current API has no durable release-attempt read model; release state is inferred from audit and artifact evidence only.",
      "buildReleaseReadiness",
      "state",
    ),
  ];
  if (input.events === undefined) {
    limitations.push(
      limitation(
        "release-artifact-evidence-unavailable",
        "Event replay was not supplied, so durable release artifact evidence cannot be proven.",
        "buildReleaseReadiness",
        "releaseArtifactIds",
      ),
    );
  }
  const outcome = audit?.outcome ?? null;
  const blocked = outcome !== null && outcome !== "pass";
  const state: ReleaseReadinessViewModel["state"] =
    audit === null
      ? "no_audit"
      : blocked
        ? "blocked"
        : releaseArtifactIds.length > 0
          ? "release_evidence_present"
          : "ready_to_release";
  const blockers = blocked
    ? [
        {
          id: "completion-audit-not-pass",
          title: "Completion audit is not passing",
          message: `Latest completion audit outcome is ${outcome}.`,
        },
      ]
    : [];
  const data: ReleaseReadinessViewModel = {
    planId: input.planId,
    state,
    completionAuditOutcome: outcome,
    completionAuditId: audit?.id ?? null,
    releaseArtifactIds,
    blockers,
    nextAction: releaseNextAction(state),
    raw: {
      ...(input.planDetail !== undefined ? { planDetail: input.planDetail } : {}),
      events,
    },
    limitations: uniqueLimitations(limitations),
  };

  return {
    state: errors.length > 0 || data.limitations.length > 0 ? "partial" : "ready",
    data,
    limitations: uniqueLimitations([...data.limitations, ...errors.map(errorLimitation)]),
    errors,
    raw: input,
  };
}

function runSummaryFromPlan(
  plan: PlanListItem,
  cockpitByPlanId: ReadonlyMap<UUID, RunCockpitViewModel> | undefined,
): RunSummaryViewModel {
  const cockpit = cockpitByPlanId?.get(plan.id);
  const contextLimitations = [
    limitation(
      "run-list-context-unavailable",
      "GET /plans does not include repo identity or spec title.",
      "buildRunSummaries",
      "context",
    ),
  ];
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    riskLevels: unique(plan.risks.map((risk) => risk.level)),
    hasCompletionAudit: plan.completionAuditReportId !== null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    attention: cockpit?.attention ?? limitedAttention("buildRunSummaries"),
    context: {
      repo: limited<string>(null, contextLimitations),
      specTitle: limited<string>(null, contextLimitations),
    },
    raw: plan,
  };
}

function buildTaskSummary(
  task: TaskListItem | ContractTask,
  ctx: {
    phase: PhaseListItem | ContractPhase | null;
    approvals: readonly ApprovalRequest[] | undefined;
    budgetRow: BudgetTaskBreakdown | null;
    detailPayload: TaskDetailPayload | undefined;
    budgetAvailable: boolean;
  },
): TaskSummaryViewModel {
  const taskDetail = ctx.detailPayload?.task;
  const approval = ctx.approvals?.find(
    (row) => row.taskId === task.id && row.status === "pending",
  );
  const approvalStatus =
    ctx.approvals === undefined
      ? limited<ApprovalStatus>(null, [
          limitation(
            "task-approval-state-unavailable",
            "Approval rows were not supplied; task approval state is not inferred locally.",
            "buildTaskSummary",
            "approvalStatus",
          ),
        ])
      : limited(approval?.status ?? null);
  const latestReviewReport = ctx.detailPayload?.latestReviewReport;
  const reviewState =
    latestReviewReport !== undefined && latestReviewReport !== null
      ? limited<ReviewOutcome>(latestReviewReport.outcome)
      : limited<ReviewOutcome>(statusDerivedReview(task.status), [
          limitation(
            "task-review-state-unavailable",
            "Task list does not include latest review; status-derived review state is a display hint.",
            "buildTaskSummary",
            "reviewState",
          ),
        ]);
  const branchName = taskDetail?.branchName ?? ("branchName" in task ? task.branchName : undefined);
  const branchLimitations = branchName === undefined
    ? [
        limitation(
          "partial-api-payload",
          "Task list does not include branch name; provide task detail or lease for branch context.",
          "buildTaskSummary",
          "branchName",
        ),
      ]
    : [];
  const budgetSpend = taskBudgetSpend(task, ctx.budgetRow, taskDetail, ctx.budgetAvailable);
  return {
    id: task.id,
    planId: task.planId,
    phaseId: task.phaseId,
    slug: task.slug,
    title: task.title,
    status: task.status,
    riskLevel: task.riskLevel,
    kind: task.kind,
    approvalStatus,
    reviewState,
    branchName: limited(branchName ?? null, branchLimitations),
    budgetSpend,
    availableActions: buildTaskActions(task, ctx.phase, approvalStatus.value),
    raw: task,
  };
}

function buildTaskActions(
  task: TaskListItem | ContractTask,
  phase: PhaseListItem | ContractPhase | null,
  approvalStatus: ApprovalStatus | null,
): ActionAvailability[] {
  const serverAuthority = limitation(
    "task-actions-server-authority",
    "Desktop only mirrors simple action affordances; API mutations remain authoritative.",
    "buildTaskActions",
    "availableActions",
  );
  const phaseMissing = phase === null
    ? [
        limitation(
          "partial-api-payload",
          "Owning phase was not supplied; phase-gated task actions cannot be decided.",
          "buildTaskActions",
          "phase",
        ),
      ]
    : [];
  return [
    action(
      "task.run",
      phase === null ? null : phase.status === "executing" && !["running", "ready_to_merge", "merged"].includes(task.status),
      phase === null
        ? "Owning phase is unavailable."
        : phase.status === "executing"
          ? null
          : `Owning phase is ${phase.status}.`,
      false,
      [serverAuthority, ...phaseMissing],
    ),
    action(
      "task.review",
      task.status === "in_review",
      task.status === "in_review" ? null : `Task is ${task.status}.`,
      false,
      [serverAuthority],
    ),
    action(
      "task.fix",
      task.status === "fixing",
      task.status === "fixing" ? null : `Task is ${task.status}.`,
      false,
      [serverAuthority],
    ),
    action(
      "task.approve",
      approvalStatus === null ? null : approvalStatus === "pending",
      approvalStatus === null
        ? "Approval rows are unavailable."
        : approvalStatus === "pending"
          ? null
          : `Approval is ${approvalStatus}.`,
      false,
      [serverAuthority],
    ),
    action(
      "task.overrideReview",
      task.status === "blocked" || task.status === "fixing",
      task.status === "blocked" || task.status === "fixing"
        ? null
        : `Task is ${task.status}.`,
      true,
      [serverAuthority],
    ),
  ];
}

function buildPlanActions(
  status: string,
  phases: readonly (PhaseListItem | ContractPhase)[],
  release: ReleaseReadinessViewModel,
): ActionAvailability[] {
  const serverAuthority = limitation(
    "task-actions-server-authority",
    "Desktop mirrors only shallow action gates; API mutations remain authoritative.",
    "buildPlanActions",
    "actions",
  );
  const allPhasesCompleted = phases.length > 0 && phases.every((phase) => phase.status === "completed");
  return [
    action(
      "plan.complete",
      allPhasesCompleted,
      allPhasesCompleted ? null : "Not every phase is completed.",
      false,
      [serverAuthority],
    ),
    action(
      "plan.release",
      release.state === "ready_to_release",
      release.state === "ready_to_release"
        ? null
        : release.state === "release_evidence_present"
          ? "Release evidence already exists."
          : "Completion audit is not ready for release.",
      false,
      [serverAuthority],
    ),
  ];
}

function taskBudgetSpend(
  task: TaskListItem | ContractTask,
  row: BudgetTaskBreakdown | null,
  taskDetail: ContractTask | undefined,
  budgetAvailable: boolean,
): LimitedValue<BudgetSpendViewModel> {
  if (!budgetAvailable) {
    return limited<BudgetSpendViewModel>(null, [
      limitation(
        "task-budget-state-unavailable",
        "Budget report was not supplied; spend is not inferred from agent runs in Desktop.",
        "buildTaskSummary",
        "budgetSpend",
      ),
    ]);
  }
  const spend = row ?? {
    taskId: task.id,
    totalUsd: 0,
    totalTokens: 0,
    totalWallClockMinutes: 0,
  };
  const capUsd = taskDetail?.budget.maxModelCostUsd ?? null;
  const capLimitations = capUsd === null
    ? [
        limitation(
          "budget-task-cap-unavailable",
          "Task budget cap is not present in the task list; provide task detail to compute over-budget state.",
          "buildTaskSummary",
          "budgetSpend.overBudget",
        ),
      ]
    : [];
  return limited({
    usd: spend.totalUsd,
    tokens: spend.totalTokens,
    wallClockMinutes: spend.totalWallClockMinutes,
    overBudget: limited(capUsd === null ? null : spend.totalUsd >= capUsd, capLimitations),
    capUsd: limited(capUsd, capLimitations),
  });
}

function buildAttention(input: {
  approvals: readonly ApprovalRequest[] | undefined;
  phases: readonly (PhaseListItem | ContractPhase)[];
  tasks: readonly (TaskListItem | ContractTask)[];
  release: ReleaseReadinessViewModel;
}): RunAttention {
  return {
    pendingApprovals: input.approvals === undefined
      ? limited<number>(null, [
          limitation(
            "run-list-attention-unavailable",
            "Pending approval count requires GET /approvals.",
            "buildAttention",
            "pendingApprovals",
          ),
        ])
      : limited(input.approvals.filter((approval) => approval.status === "pending").length),
    blockedTasks: input.tasks.length === 0
      ? limited<number>(null, [
          limitation(
            "run-list-attention-unavailable",
            "Blocked task count requires GET /tasks.",
            "buildAttention",
            "blockedTasks",
          ),
        ])
      : limited(input.tasks.filter((task) => task.status === "blocked").length),
    failedTasks: input.tasks.length === 0
      ? limited<number>(null, [
          limitation(
            "run-list-attention-unavailable",
            "Failed task count requires GET /tasks.",
            "buildAttention",
            "failedTasks",
          ),
        ])
      : limited(input.tasks.filter((task) => task.status === "failed").length),
    blockedPhases: input.phases.length === 0
      ? limited<number>(null, [
          limitation(
            "run-list-attention-unavailable",
            "Blocked phase count requires GET /phases.",
            "buildAttention",
            "blockedPhases",
          ),
        ])
      : limited(input.phases.filter((phase) => phase.status === "blocked" || phase.status === "failed").length),
    releaseReady: limited(input.release.state === "ready_to_release", input.release.limitations),
  };
}

function limitedAttention(source: string): RunAttention {
  const make = <T>(field: string): LimitedValue<T> =>
    limited<T>(null, [
      limitation(
        "run-list-attention-unavailable",
        "GET /plans does not include attention counts; hydrate cockpit reads to fill this field.",
        source,
        field,
      ),
    ]);
  return {
    pendingApprovals: make("pendingApprovals"),
    blockedTasks: make("blockedTasks"),
    failedTasks: make("failedTasks"),
    blockedPhases: make("blockedPhases"),
    releaseReady: make("releaseReady"),
  };
}

function eventItemFromWorkflowEvent(
  event: WorkflowEvent,
  phaseById: ReadonlyMap<UUID, { id: UUID; title: string; status?: PhaseStatus }>,
  taskById: ReadonlyMap<UUID, { id: UUID; title: string; slug: string; status?: TaskStatus; phaseId: UUID }>,
): EventItemViewModel {
  switch (event.kind) {
    case "phase_status_changed": {
      const phase = phaseById.get(event.phaseId);
      const limitations = phase === undefined
        ? [
            limitation(
              "event-subject-context-unavailable",
              "Phase event was replayed without joined phase context.",
              "buildEventReplay",
              "phaseId",
            ),
          ]
        : [];
      return {
        id: event.id,
        planId: event.planId,
        kind: event.kind,
        createdAt: event.createdAt,
        phaseId: event.phaseId,
        taskId: null,
        artifactId: null,
        artifactKind: null,
        uri: null,
        label: `${phase?.title ?? event.phaseId} -> ${event.payload.nextStatus}`,
        severity: severityForStatus(event.payload.nextStatus),
        raw: event,
        limitations,
      };
    }
    case "task_status_changed": {
      const task = taskById.get(event.taskId);
      const limitations = task === undefined
        ? [
            limitation(
              "event-subject-context-unavailable",
              "Task event was replayed without joined task context.",
              "buildEventReplay",
              "taskId",
            ),
          ]
        : [];
      return {
        id: event.id,
        planId: event.planId,
        kind: event.kind,
        createdAt: event.createdAt,
        phaseId: event.phaseId,
        taskId: event.taskId,
        artifactId: null,
        artifactKind: null,
        uri: null,
        label: `${task?.slug ?? event.taskId} -> ${event.payload.nextStatus}`,
        severity: severityForStatus(event.payload.nextStatus),
        raw: event,
        limitations,
      };
    }
    case "artifact_persisted":
      return {
        id: event.id,
        planId: event.planId,
        kind: event.kind,
        createdAt: event.createdAt,
        phaseId: null,
        taskId: null,
        artifactId: event.payload.artifactId,
        artifactKind: event.payload.artifactKind,
        uri: event.payload.uri,
        label: `Persisted ${event.payload.artifactKind}`,
        severity: "info",
        raw: event,
        limitations: [
          limitation(
            "artifact-metadata-unavailable",
            "Artifact event carries kind and URI but not title, content type, phase, or task metadata.",
            "buildEventReplay",
            "artifactId",
          ),
        ],
      };
  }
}

function artifactSummaryFromSources(
  planId: UUID,
  id: UUID,
  event: Extract<WorkflowEvent, { kind: "artifact_persisted" }> | undefined,
  fetch: ArtifactFetchPayload | undefined,
): ArtifactSummaryViewModel {
  const metadataLimitations = event === undefined
    ? [
        limitation(
          "artifact-metadata-unavailable",
          "Plan detail exposes only artifact ids; artifact metadata requires an artifact event or a future metadata endpoint.",
          "buildArtifactEvidence",
          "artifact",
        ),
      ]
    : [];
  const trustedLimitation = limitation(
    "artifact-trusted-open-unavailable",
    "Renderer cannot derive a trusted local open path from streamed artifact content.",
    "buildArtifactEvidence",
    "trustedOpenState",
  );
  const fetchError = fetch?.error;
  return {
    id,
    kind: limited(event?.payload.artifactKind ?? null, metadataLimitations),
    title: limited(
      event === undefined ? null : titleForArtifactKind(event.payload.artifactKind),
      metadataLimitations,
    ),
    planId,
    taskId: limited<UUID>(null, metadataLimitations),
    phaseId: limited<UUID>(null, metadataLimitations),
    createdAt: limited(event?.createdAt ?? null, metadataLimitations),
    contentType: limited(fetch?.contentType ?? null, fetch === undefined ? metadataLimitations : []),
    fetchStatus: fetchError !== undefined ? "errored" : fetch?.body !== undefined ? "loaded" : "idle",
    trustedOpenState: limited<"validated">(null, [trustedLimitation]),
    body: fetch?.body ?? null,
    byteLength: fetch?.byteLength ?? (fetch?.body === null || fetch?.body === undefined ? null : fetch.body.length),
    raw: {
      ...(event !== undefined ? { event } : {}),
      ...(fetch !== undefined ? { fetch } : {}),
    },
  };
}

function describeBlocker(
  planStatus: string,
  phases: readonly (PhaseListItem | ContractPhase)[],
  tasks: readonly (TaskListItem | ContractTask)[],
  release: ReleaseReadinessViewModel,
): RunCockpitViewModel["blocker"] {
  if (planStatus === "blocked" || planStatus === "failed") {
    return {
      message: `Plan is ${planStatus}; inspect failed phases and tasks before retrying.`,
      subjectId: null,
      subjectType: "plan",
    };
  }
  const failedTask = tasks.find((task) => task.status === "failed" || task.status === "blocked");
  if (failedTask !== undefined) {
    return {
      message: `Task "${failedTask.title}" is ${failedTask.status}.`,
      subjectId: failedTask.id,
      subjectType: "task",
    };
  }
  const failedPhase = phases.find((phase) => phase.status === "failed" || phase.status === "blocked");
  if (failedPhase !== undefined) {
    return {
      message: `Phase "${failedPhase.title}" is ${failedPhase.status}.`,
      subjectId: failedPhase.id,
      subjectType: "phase",
    };
  }
  if (release.blockers.length > 0) {
    return {
      message: release.blockers[0]?.message ?? "Release is blocked.",
      subjectId: release.completionAuditId,
      subjectType: "release",
    };
  }
  return { message: "No blockers.", subjectId: null, subjectType: null };
}

function describePlanStatus(status: string): string {
  switch (status) {
    case "draft":
      return "Draft: planner has not started.";
    case "executing":
      return "Executing: workers can pick up tasks.";
    case "auditing":
      return "Auditing: completion auditor is running.";
    case "approved":
      return "Approved: plan audit has passed.";
    case "completed":
      return "Completed: release readiness can be evaluated.";
    case "released":
      return "Released: durable release evidence should be checked.";
    case "blocked":
      return "Blocked: operator action is required.";
    case "failed":
      return "Failed: inspect blocker evidence.";
    default:
      return "Unknown state.";
  }
}

function describeNextAction(status: string, release: ReleaseReadinessViewModel): string {
  if (release.state === "ready_to_release") return "Release the plan.";
  if (release.state === "blocked") return "Resolve completion-audit blockers.";
  if (release.state === "release_evidence_present") return "Inspect release evidence.";
  if (status === "completed") return "Run completion audit.";
  if (status === "executing" || status === "auditing") return "Wait for active workflow state or refresh.";
  if (status === "blocked" || status === "failed") return "Resolve the blocker and re-drive through the API.";
  return "Start or continue planning.";
}

function releaseNextAction(state: ReleaseReadinessViewModel["state"]): string {
  switch (state) {
    case "ready_to_release":
      return "Release the plan.";
    case "release_evidence_present":
      return "Inspect release artifacts.";
    case "blocked":
      return "Resolve completion audit blockers.";
    case "no_audit":
      return "Run completion audit.";
    case "unknown":
      return "Refresh release context.";
  }
}

function normalizeAcceptanceCriterion(row: AcceptanceCriterion) {
  return {
    id: row.id,
    title: row.title ?? row.description ?? row.id,
    verify: row.verify ?? row.verificationCommands?.join(" && ") ?? "",
    required: row.required ?? true,
  };
}

function fieldValue<
  TPayload extends object,
  TKey extends keyof TPayload,
>(
  payload: TPayload,
  key: TKey,
  code: Limitation["code"],
  field: string,
): LimitedValue<NonNullable<TPayload[TKey]>> {
  if (!hasOwn(payload, key)) {
    return limited<NonNullable<TPayload[TKey]>>(null, [
      limitation(
        code,
        `Task detail payload does not include ${field}.`,
        "buildTaskDetail",
        field,
      ),
    ]);
  }
  return limited((payload[key] ?? null) as NonNullable<TPayload[TKey]> | null);
}

function arrayFieldValue<
  TPayload extends object,
  TKey extends keyof TPayload,
>(
  payload: TPayload,
  key: TKey,
  code: Limitation["code"],
  field: string,
): LimitedValue<NonNullable<TPayload[TKey]>> {
  if (!hasOwn(payload, key)) {
    return limited<NonNullable<TPayload[TKey]>>(null, [
      limitation(
        code,
        `Task detail payload does not include ${field}.`,
        "buildTaskDetail",
        field,
      ),
    ]);
  }
  return limited((payload[key] ?? []) as NonNullable<TPayload[TKey]>);
}

function limitation(
  code: Limitation["code"],
  message: string,
  source: string,
  field?: string,
): Limitation {
  return field === undefined ? { code, message, source } : { code, message, source, field };
}

function errorLimitation(error: RecoverableReadError): Limitation {
  return limitation(
    "recoverable-api-error",
    error.message,
    "api",
    String(error.status),
  );
}

function limited<T>(value: T | null, limitations: Limitation[] = []): LimitedValue<T> {
  return { value, limitations: uniqueLimitations(limitations) };
}

function action(
  actionKind: ActionAvailability["action"],
  enabled: boolean | null,
  reason: string | null,
  requiresReason: boolean,
  limitations: Limitation[],
): ActionAvailability {
  return {
    action: actionKind,
    enabled,
    reason,
    requiresConfirmation: true,
    requiresReason,
    pending: false,
    limitations: uniqueLimitations(limitations),
  };
}

function compact<T>(values: readonly (T | null | undefined)[]): T[] {
  return values.filter((value): value is T => value !== null && value !== undefined);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
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

function stateForCollection(count: number, errorCount: number, payloadPresent: boolean) {
  if (errorCount > 0 && count === 0) return "error";
  if (errorCount > 0) return "partial";
  if (!payloadPresent || count === 0) return "empty";
  return "ready";
}

function attentionLimitations(attention: RunAttention): Limitation[] {
  return [
    ...attention.pendingApprovals.limitations,
    ...attention.blockedTasks.limitations,
    ...attention.failedTasks.limitations,
    ...attention.blockedPhases.limitations,
    ...attention.releaseReady.limitations,
  ];
}

function taskSummaryLimitations(task: TaskSummaryViewModel): Limitation[] {
  return [
    ...task.approvalStatus.limitations,
    ...task.reviewState.limitations,
    ...task.branchName.limitations,
    ...task.budgetSpend.limitations,
    ...(task.budgetSpend.value === null
      ? []
      : [
          ...task.budgetSpend.value.overBudget.limitations,
          ...task.budgetSpend.value.capUsd.limitations,
        ]),
    ...task.availableActions.flatMap((actionRow) => actionRow.limitations),
  ];
}

function artifactLimitations(artifact: ArtifactSummaryViewModel): Limitation[] {
  return [
    ...artifact.kind.limitations,
    ...artifact.title.limitations,
    ...artifact.taskId.limitations,
    ...artifact.phaseId.limitations,
    ...artifact.createdAt.limitations,
    ...artifact.contentType.limitations,
    ...artifact.trustedOpenState.limitations,
    ...(artifact.raw.fetch?.error === undefined ? [] : [errorLimitation(artifact.raw.fetch.error)]),
  ];
}

function mapById<T extends { id: UUID }>(items: readonly T[]): ReadonlyMap<UUID, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function mapTaskLikeById(
  items: readonly (TaskSummaryViewModel | TaskListItem)[],
): ReadonlyMap<UUID, TaskSummaryViewModel | TaskListItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function mapPhaseLikeById(
  items: readonly (PhaseViewModel | PhaseListItem)[],
): ReadonlyMap<UUID, PhaseViewModel | PhaseListItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function budgetBreakdownByTask(budget: BudgetReport | undefined): ReadonlyMap<UUID, BudgetTaskBreakdown> {
  return new Map((budget?.perTaskBreakdown ?? []).map((row) => [row.taskId, row]));
}

function countTasksByStatus(tasks: readonly (TaskListItem | ContractTask)[]): TaskCountsByStatus {
  const counts: TaskCountsByStatus = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function countTasksByPhase(tasks: readonly TaskListItem[]): ReadonlyMap<UUID, TaskCountsByStatus> {
  const byPhase = new Map<UUID, TaskCountsByStatus>();
  for (const task of tasks) {
    const counts = byPhase.get(task.phaseId) ?? {};
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    byPhase.set(task.phaseId, counts);
  }
  return byPhase;
}

function phasesFromPlan(plan: PlanDetailPayload["plan"]): PhaseListItem[] {
  return plan.phases.map((phase) => ({
    id: phase.id,
    planId: phase.planId,
    index: phase.index,
    title: phase.title,
    summary: phase.summary,
    status: phase.status,
    integrationBranch: phase.integrationBranch,
    phaseAuditReportId: phaseAuditId(phase),
    startedAt: nullableIso(phase.startedAt),
    completedAt: nullableIso(phase.completedAt),
  }));
}

function tasksFromPlan(plan: PlanDetailPayload["plan"]): TaskListItem[] {
  return plan.tasks.map((task) => ({
    id: task.id,
    planId: task.planId,
    phaseId: task.phaseId,
    slug: task.slug,
    title: task.title,
    status: task.status,
    riskLevel: task.riskLevel,
    kind: task.kind,
  }));
}

function phaseAuditId(phase: PhaseListItem | ContractPhase): UUID | null {
  if ("phaseAuditReportId" in phase) {
    return phase.phaseAuditReportId ?? null;
  }
  return null;
}

function nullableIso(value: string | null | undefined): string | null {
  return value ?? null;
}

function statusDerivedReview(status: TaskStatus): ReviewOutcome | null {
  if (status === "in_review") return "pending";
  if (status === "ready_to_merge" || status === "merged") return "pass";
  if (status === "fixing") return "changes_requested";
  if (status === "blocked" || status === "failed") return "blocked";
  return null;
}

function taskBudgetCap(task: TaskSummaryViewModel | TaskListItem | undefined): number | null {
  if (task === undefined) return null;
  if ("budgetSpend" in task) {
    return task.budgetSpend.value?.capUsd.value ?? null;
  }
  return null;
}

function severityForStatus(status: string): EventItemViewModel["severity"] {
  if (status === "failed") return "error";
  if (status === "blocked") return "warn";
  return "info";
}

function artifactEventsById(
  events: readonly WorkflowEvent[],
): ReadonlyMap<UUID, Extract<WorkflowEvent, { kind: "artifact_persisted" }>> {
  const out = new Map<UUID, Extract<WorkflowEvent, { kind: "artifact_persisted" }>>();
  for (const event of events) {
    if (event.kind === "artifact_persisted") {
      out.set(event.payload.artifactId, event);
    }
  }
  return out;
}

function isReleaseArtifactKind(kind: ArtifactKind): boolean {
  return kind === "pr_summary" || kind === "completion_evidence_bundle";
}

function titleForArtifactKind(kind: ArtifactKind): string {
  return kind.replace(/_/g, " ");
}

function evidenceReleaseState(
  outcome: CompletionAuditOutcome | null,
  releaseArtifactCount: number,
): EvidenceBundleViewModel["releaseState"] {
  if (outcome === null) return "no_audit";
  if (outcome !== "pass") return "audit_blocked";
  return releaseArtifactCount > 0 ? "release_evidence_present" : "ready_to_release";
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}
