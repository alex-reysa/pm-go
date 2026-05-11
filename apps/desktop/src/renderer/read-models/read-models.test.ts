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
      taskIds: [taskId],
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
    outcome: "pass",
    checklist: [{ id: "check", status: "passed" }],
    findings: [],
    summary: { acceptanceCriteriaPassed: ["ac-live"] },
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
        workflowRunId: "workflow-run",
        role: "implementer",
        status: "completed",
        costUsd: 4,
      },
      latestLease: {
        id: "bbbbbbbb-1111-4111-8111-bbbbbbbb1111",
        taskId,
        branchName: "task-live",
        worktreePath: "/tmp/task-live",
        baseSha: "abc123",
      },
      latestReviewReport: {
        id: "cccccccc-1111-4111-8111-cccccccc1111",
        taskId,
        outcome: "pass",
        findingsCount: 0,
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
