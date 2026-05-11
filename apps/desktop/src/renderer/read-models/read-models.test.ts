import { describe, expect, it } from "vitest";

import {
  buildApprovals,
  buildArtifactEvidence,
  buildBudgetSnapshot,
  buildEventReplay,
  buildPhases,
  buildReleaseReadiness,
  buildRunCockpit,
  buildRunSummaries,
  buildTaskDetail,
  buildTaskSummaries,
} from "./index.js";
import type {
  ApprovalRequest,
  BudgetReport,
  ContractPlan,
  PhaseListItem,
  PlanDetailPayload,
  PlanListItem,
  RecoverableReadError,
  TaskDetailPayload,
  TaskListItem,
  WorkflowEvent,
} from "./types.js";

const planId = "11111111-1111-4111-8111-111111111111";
const phaseId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";

const plan: ContractPlan = {
  id: planId,
  specDocumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  repoSnapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Live run",
  summary: "Run reconstructed from API payloads.",
  status: "completed",
  risks: [
    {
      id: "risk-1",
      level: "high",
      title: "Risk",
      description: "High-risk task.",
      mitigation: "Review.",
      humanApprovalRequired: true,
    },
  ],
  phases: [
    {
      id: phaseId,
      planId,
      index: 0,
      title: "Phase 0",
      summary: "Foundation phase.",
      status: "completed",
      integrationBranch: "phase-0",
      baseSnapshotId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      taskIds: [taskId],
      dependencyEdges: [],
      mergeOrder: [taskId],
      startedAt: "2026-05-10T10:00:00.000Z",
      completedAt: "2026-05-10T11:00:00.000Z",
      phaseAuditReportId: "55555555-5555-4555-8555-555555555555",
    },
  ],
  tasks: [
    {
      id: taskId,
      planId,
      phaseId,
      slug: "live-task",
      title: "Live task",
      summary: "Task detail from API.",
      kind: "foundation",
      status: "ready_to_merge",
      riskLevel: "high",
      fileScope: { includes: ["apps/desktop/src/renderer/read-models/**"] },
      acceptanceCriteria: [
        {
          id: "ac-live",
          description: "Live read models map payloads.",
          verificationCommands: ["pnpm --filter @pm-go/desktop test"],
          required: true,
        },
      ],
      testCommands: ["pnpm --filter @pm-go/desktop test"],
      budget: {
        maxWallClockMinutes: 30,
        maxModelCostUsd: 10,
        maxPromptTokens: 100_000,
      },
      reviewerPolicy: {
        required: true,
        strictness: "elevated",
        maxCycles: 2,
        reviewerWriteAccess: false,
        stopOnHighSeverityCount: 1,
      },
      requiresHumanApproval: true,
      maxReviewFixCycles: 2,
      branchName: "task-live",
      worktreePath: "/tmp/task-live",
    },
  ],
  createdAt: "2026-05-10T09:00:00.000Z",
  updatedAt: "2026-05-10T12:00:00.000Z",
};

const planDetail: PlanDetailPayload = {
  plan,
  artifactIds: [artifactId],
  latestCompletionAudit: {
    id: "66666666-6666-4666-8666-666666666666",
    planId,
    finalPhaseId: phaseId,
    mergeRunId: "12121212-1212-4121-8121-121212121212",
    auditorRunId: "13131313-1313-4131-8131-131313131313",
    auditedHeadSha: "abc123",
    outcome: "pass",
    checklist: [
      {
        id: "check",
        title: "Acceptance evidence",
        status: "passed",
        evidenceArtifactIds: [artifactId],
      },
    ],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: ["ac-live"],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: "2026-05-10T12:01:00.000Z",
  },
};

const phaseList: PhaseListItem[] = [
  {
    id: phaseId,
    planId,
    index: 0,
    title: "Phase 0",
    summary: "Foundation phase.",
    status: "completed",
    integrationBranch: "phase-0",
    phaseAuditReportId: "55555555-5555-4555-8555-555555555555",
    startedAt: "2026-05-10T10:00:00.000Z",
    completedAt: "2026-05-10T11:00:00.000Z",
  },
];

const taskList: TaskListItem[] = [
  {
    id: taskId,
    planId,
    phaseId,
    slug: "live-task",
    title: "Live task",
    status: "ready_to_merge",
    riskLevel: "high",
    kind: "foundation",
  },
];

const approvals: ApprovalRequest[] = [
  {
    id: "77777777-7777-4777-8777-777777777777",
    planId,
    taskId,
    subject: "task",
    riskBand: "high",
    status: "pending",
    requestedAt: "2026-05-10T11:30:00.000Z",
    requestedBy: "reviewer-agent",
  },
];

const budget: BudgetReport = {
  id: "88888888-8888-4888-8888-888888888888",
  planId,
  totalUsd: 4,
  totalTokens: 1200,
  totalWallClockMinutes: 12,
  generatedAt: "2026-05-10T12:02:00.000Z",
  perTaskBreakdown: [
    {
      taskId,
      totalUsd: 4,
      totalTokens: 1200,
      totalWallClockMinutes: 12,
    },
  ],
};

const releaseEvent: WorkflowEvent = {
  id: "99999999-9999-4999-8999-999999999999",
  planId,
  kind: "artifact_persisted",
  payload: {
    artifactId,
    artifactKind: "pr_summary",
    uri: "file:///tmp/artifacts/pr.md",
  },
  createdAt: "2026-05-10T12:03:00.000Z",
};

describe("desktop live read models", () => {
  it("maps live API payloads into stable UI models while preserving raw payloads", () => {
    const cockpit = buildRunCockpit({
      planDetail,
      phases: phaseList,
      tasks: taskList,
      approvals,
      budget,
      events: [releaseEvent],
    });

    expect(cockpit.data?.raw.planDetail).toBe(planDetail);
    expect(cockpit.data?.currentState.phaseCount.value).toBe(1);
    expect(cockpit.data?.currentState.taskCountsByStatus.value).toEqual({
      ready_to_merge: 1,
    });
    expect(cockpit.data?.attention.pendingApprovals.value).toBe(1);
    expect(cockpit.data?.release.state).toBe("release_evidence_present");

    const runListItem: PlanListItem = {
      id: planId,
      title: plan.title,
      summary: plan.summary,
      status: plan.status,
      risks: plan.risks,
      completionAuditReportId: planDetail.latestCompletionAudit?.id ?? null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
    const runs = buildRunSummaries({
      plans: [runListItem],
      cockpitByPlanId: new Map([[planId, cockpit.data!]]),
    });
    expect(runs.data[0]?.riskLevels).toEqual(["high"]);
    expect(runs.data[0]?.attention.pendingApprovals.value).toBe(1);
    expect(runs.data[0]?.context.repo.limitations[0]?.code).toBe(
      "run-list-context-unavailable",
    );

    const phases = buildPhases({ phases: phaseList, tasks: taskList });
    expect(phases.data[0]?.taskCountsByStatus.value).toEqual({
      ready_to_merge: 1,
    });

    const taskDetailPayload: TaskDetailPayload = {
      task: plan.tasks[0]!,
      latestAgentRun: {
        id: "aaaaaaaa-1111-4111-8111-aaaaaaaa1111",
        taskId,
        planId,
        workflowRunId: "workflow-run",
        role: "implementer",
        depth: 0,
        status: "completed",
        riskLevel: "high",
        executor: "codex",
        model: "gpt-5",
        promptVersion: "desktop-read-models-test",
        permissionMode: "default",
        costUsd: 4,
      },
      latestLease: {
        id: "bbbbbbbb-1111-4111-8111-bbbbbbbb1111",
        taskId,
        repoRoot: "/repo",
        branchName: "task-live",
        worktreePath: "/tmp/task-live",
        baseSha: "abc123",
        expiresAt: "2026-05-11T12:00:00.000Z",
        status: "active",
      },
      latestReviewReport: {
        id: "cccccccc-1111-4111-8111-cccccccc1111",
        taskId,
        reviewerRunId: "aaaaaaaa-1111-4111-8111-aaaaaaaa1111",
        outcome: "pass",
        findings: [],
        createdAt: "2026-05-10T12:00:00.000Z",
      },
      taskPolicyDecisions: [],
    };
    const taskSummaries = buildTaskSummaries({
      tasks: taskList,
      phases: phaseList,
      approvals,
      budget,
      taskDetails: new Map([[taskId, taskDetailPayload]]),
    });
    expect(taskSummaries.data[0]?.approvalStatus.value).toBe("pending");
    expect(taskSummaries.data[0]?.budgetSpend.value?.overBudget.value).toBe(false);

    const detail = buildTaskDetail({
      payload: taskDetailPayload,
      phase: phaseList[0],
      approvals,
      budget,
      reviewReports: [taskDetailPayload.latestReviewReport!],
      agentRuns: [taskDetailPayload.latestAgentRun!],
      relatedEvents: [],
      relatedArtifacts: [],
    });
    expect(detail.data?.raw).toBe(taskDetailPayload);
    expect(detail.data?.latestLease.value?.branchName).toBe("task-live");
    expect(detail.data?.acceptanceCriteria[0]?.verify).toBe(
      "pnpm --filter @pm-go/desktop test",
    );

    const evidence = buildArtifactEvidence({
      planId,
      planDetail,
      artifactIds: planDetail.artifactIds,
      events: [releaseEvent],
      fetches: [
        {
          id: artifactId,
          contentType: "text/markdown",
          body: "# Release\n",
          byteLength: 10,
        },
      ],
    });
    expect(evidence.data.releaseArtifacts[0]?.kind.value).toBe("pr_summary");
    expect(evidence.data.artifactContents[0]?.body).toBe("# Release\n");
  });

  it("returns explicit empty states for empty API collections", () => {
    expect(buildRunSummaries({ plans: [] }).state).toBe("empty");
    expect(buildPhases({ phases: [], tasks: [] }).data).toEqual([]);
    expect(buildEventReplay({ events: [] }).state).toBe("empty");
    expect(buildApprovals({ approvals: [] }).state).toBe("empty");
  });

  it("uses plan-detail tasks for phase counts", () => {
    const phases = buildPhases({ planDetail });

    expect(phases.data[0]?.taskCountsByStatus.value).toEqual({
      ready_to_merge: 1,
    });
    expect(phases.limitations.map((item) => item.code)).not.toContain(
      "phase-task-counts-unavailable",
    );
  });

  it("reflects decided approval rows while preferring a pending row", () => {
    const approved: ApprovalRequest = {
      ...approvals[0]!,
      id: "77777777-7777-4777-8777-777777777778",
      status: "approved",
      decidedAt: "2026-05-10T11:45:00.000Z",
    };

    expect(
      buildTaskSummaries({
        tasks: taskList,
        approvals: [approved],
      }).data[0]?.approvalStatus.value,
    ).toBe("approved");
    expect(
      buildTaskSummaries({
        tasks: taskList,
        approvals: [approved, approvals[0]!],
      }).data[0]?.approvalStatus.value,
    ).toBe("pending");
  });

  it("falls back to latest lease branch names for task summaries", () => {
    const taskWithoutBranch = { ...plan.tasks[0]! };
    delete taskWithoutBranch.branchName;
    const taskDetails = new Map<string, TaskDetailPayload>([
      [
        taskId,
        {
          task: taskWithoutBranch,
          latestLease: {
            id: "bbbbbbbb-2222-4222-8222-bbbbbbbb2222",
            taskId,
            repoRoot: "/repo",
            branchName: "lease-task-live",
            worktreePath: "/tmp/task-live",
            baseSha: "abc123",
            expiresAt: "2026-05-11T12:00:00.000Z",
            status: "active",
          },
        },
      ],
    ]);

    const summaries = buildTaskSummaries({
      tasks: taskList,
      taskDetails,
    });

    expect(summaries.data[0]?.branchName.value).toBe("lease-task-live");
    expect(summaries.data[0]?.branchName.limitations).toEqual([]);
  });

  it("computes budget overruns from every available cap using strict greater-than", () => {
    const atCaps: BudgetReport = {
      ...budget,
      totalUsd: 10,
      totalTokens: 100_000,
      totalWallClockMinutes: 30,
      perTaskBreakdown: [
        {
          taskId,
          totalUsd: 10,
          totalTokens: 100_000,
          totalWallClockMinutes: 30,
        },
      ],
    };
    const overTokenCap: BudgetReport = {
      ...budget,
      totalUsd: 1,
      totalTokens: 100_001,
      totalWallClockMinutes: 1,
      perTaskBreakdown: [
        {
          taskId,
          totalUsd: 1,
          totalTokens: 100_001,
          totalWallClockMinutes: 1,
        },
      ],
    };

    expect(
      buildBudgetSnapshot({
        budget: atCaps,
        tasks: plan.tasks,
      }).data?.perTask[0]?.overBudget.value,
    ).toBe(false);
    expect(
      buildBudgetSnapshot({
        budget: overTokenCap,
        tasks: plan.tasks,
      }).data?.perTask[0]?.overBudget.value,
    ).toBe(true);
    expect(
      buildTaskSummaries({
        tasks: taskList,
        budget: overTokenCap,
        taskDetails: new Map([[taskId, { task: plan.tasks[0]! }]]),
      }).data[0]?.budgetSpend.value?.overBudget.value,
    ).toBe(true);
  });

  it("marks partial payload gaps as limitations instead of inventing authority", () => {
    const partialTask = buildTaskDetail({
      payload: { task: plan.tasks[0]! },
    });

    expect(partialTask.state).toBe("partial");
    expect(partialTask.limitations.map((item) => item.code)).toContain(
      "task-lease-unavailable",
    );
    expect(partialTask.limitations.map((item) => item.code)).toContain(
      "task-policy-decisions-unavailable",
    );
    expect(
      partialTask.data?.availableActions.some((item) =>
        item.limitations.some(
          (limitation) => limitation.code === "task-actions-server-authority",
        ),
      ),
    ).toBe(true);

    const artifactOnly = buildArtifactEvidence({
      planId,
      artifactIds: [artifactId],
    });
    expect(artifactOnly.data.releaseArtifacts).toEqual([]);
    expect(artifactOnly.limitations.map((item) => item.code)).toContain(
      "artifact-metadata-unavailable",
    );

    const approvalsOnly = buildApprovals({ approvals });
    expect(approvalsOnly.data[0]?.taskTitle.value).toBeNull();
    expect(approvalsOnly.limitations.map((item) => item.code)).toContain(
      "approval-bulk-policy-server-authority",
    );
  });

  it("keeps stale raw payloads available for recoverable error inputs", () => {
    const error: RecoverableReadError = {
      status: 503,
      message: "service unavailable",
      body: { error: "service_unavailable" },
      requestId: "req-1",
    };

    const events = buildEventReplay({
      events: [releaseEvent],
      error,
    });
    expect(events.state).toBe("partial");
    expect(events.errors[0]).toBe(error);
    expect(events.raw[0]).toBe(releaseEvent);
    expect(events.limitations.map((item) => item.code)).toContain(
      "recoverable-api-error",
    );

    const budgetError = buildBudgetSnapshot({ error });
    expect(budgetError.state).toBe("error");
    expect(budgetError.data).toBeNull();

    const release = buildReleaseReadiness({
      planId,
      planDetail,
      error,
    });
    expect(release.state).toBe("partial");
    expect(release.data.raw.planDetail).toBe(planDetail);
  });
});
