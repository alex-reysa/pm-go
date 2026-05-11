/**
 * End-to-end "live" pipeline: mocked fetch → DesktopApiClient →
 * read-model builders → renderer-shaped view models.
 *
 * The unit tests under `src/renderer/read-models/read-models.test.ts`
 * cover the builders against handcrafted payloads. This file
 * checks the *integration* boundary the routes will use in M3:
 *
 *   1. Build a typed mock for each canonical API response.
 *   2. Push it through the real `createDesktopApiClient` with a
 *      stubbed fetch so we exercise normalization + body parsing.
 *   3. Feed the client's outputs into `buildRunSummaries`,
 *      `buildRunCockpit`, and `buildTaskDetail`.
 *   4. Assert the resulting view models carry the live attention
 *      counts, the cockpit reconstruction is honest about
 *      `release_evidence_present`, and the task-detail view model
 *      surfaces the lease + review report joined from the API.
 *
 * Manual refresh story: the "refresh" cycle is modeled by issuing a
 * second listPlans against a different stub state and checking
 * the rebuilt summaries no longer reference the stale attention.
 * Disconnected/error fallback is checked by responding 503 to the
 * cockpit reads and asserting the read-model envelope still carries
 * the prior raw payload + a recoverable error.
 */

import { describe, expect, it } from "vitest";

import { ApiError, createDesktopApiClient } from "../../../src/renderer/api/client.js";
import {
  buildRunCockpit,
  buildRunSummaries,
  buildTaskDetail,
} from "../../../src/renderer/read-models/index.js";
import type {
  ApprovalRequest,
  BudgetReport,
  PhaseListItem,
  PlanDetailPayload,
  PlanListItem,
  TaskDetailPayload,
  TaskListItem,
  WorkflowEvent,
} from "../../../src/renderer/read-models/types.js";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";

const PLAN_LIST_PAYLOAD: { plans: PlanListItem[] } = {
  plans: [
    {
      id: PLAN_ID,
      title: "Live run from mocked fetch",
      summary: "Plan that proves the runs list view model carries the wire data.",
      status: "executing",
      risks: [
        {
          id: "risk-1",
          level: "high",
          title: "High-risk task",
          description: "needs review",
          mitigation: "human approval",
          humanApprovalRequired: true,
        },
      ],
      completionAuditReportId: null,
      createdAt: "2026-05-10T09:00:00.000Z",
      updatedAt: "2026-05-10T12:00:00.000Z",
    },
  ],
};

const PHASE_LIST_PAYLOAD: { planId: string; phases: PhaseListItem[] } = {
  planId: PLAN_ID,
  phases: [
    {
      id: PHASE_ID,
      planId: PLAN_ID,
      index: 0,
      title: "Phase 0",
      summary: "Foundation phase.",
      status: "executing",
      integrationBranch: "phase-0",
      phaseAuditReportId: null,
      startedAt: "2026-05-10T10:00:00.000Z",
      completedAt: null,
    },
  ],
};

const TASK_LIST_PAYLOAD: { tasks: TaskListItem[] } = {
  tasks: [
    {
      id: TASK_ID,
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      slug: "live-task",
      title: "Live task wired through fetch",
      status: "in_review",
      riskLevel: "high",
      kind: "feature",
    },
  ],
};

const APPROVALS_PAYLOAD: { planId: string; approvals: ApprovalRequest[] } = {
  planId: PLAN_ID,
  approvals: [
    {
      id: "approval-1",
      planId: PLAN_ID,
      taskId: TASK_ID,
      subject: "task",
      riskBand: "high",
      status: "pending",
      requestedAt: "2026-05-10T11:30:00.000Z",
      requestedBy: "reviewer-agent",
    },
  ],
};

const PLAN_DETAIL_PAYLOAD: PlanDetailPayload = {
  plan: {
    id: PLAN_ID,
    specDocumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repoSnapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Live run from mocked fetch",
    summary: "Plan detail body for the cockpit reconstruction test.",
    status: "executing",
    risks: PLAN_LIST_PAYLOAD.plans[0]!.risks,
    phases: [
      {
        id: PHASE_ID,
        planId: PLAN_ID,
        index: 0,
        title: "Phase 0",
        summary: "Foundation phase.",
        status: "executing",
        integrationBranch: "phase-0",
        baseSnapshotId: "snap",
        taskIds: [TASK_ID],
        dependencyEdges: [],
        mergeOrder: [TASK_ID],
        startedAt: "2026-05-10T10:00:00.000Z",
      },
    ],
    tasks: [
      {
        id: TASK_ID,
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        slug: "live-task",
        title: "Live task wired through fetch",
        summary: "Task summary from the plan detail body.",
        kind: "feature",
        status: "in_review",
        riskLevel: "high",
        fileScope: { includes: ["apps/desktop/test/renderer/**"] },
        acceptanceCriteria: [
          {
            id: "ac-live-pipeline",
            description: "Live pipeline maps fetched payloads into the cockpit.",
            verificationCommands: ["pnpm --filter @pm-go/desktop test"],
            required: true,
          },
        ],
        testCommands: ["pnpm --filter @pm-go/desktop test"],
        budget: {
          maxWallClockMinutes: 60,
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
  },
  artifactIds: [ARTIFACT_ID],
  latestCompletionAudit: null,
};

const BUDGET_PAYLOAD: BudgetReport = {
  id: "88888888-8888-4888-8888-888888888888",
  planId: PLAN_ID,
  totalUsd: 4,
  totalTokens: 1200,
  totalWallClockMinutes: 12,
  generatedAt: "2026-05-10T12:02:00.000Z",
  perTaskBreakdown: [
    {
      taskId: TASK_ID,
      totalUsd: 4,
      totalTokens: 1200,
      totalWallClockMinutes: 12,
    },
  ],
};

const TASK_DETAIL_PAYLOAD: TaskDetailPayload = {
  task: PLAN_DETAIL_PAYLOAD.plan.tasks[0]!,
  latestAgentRun: {
    id: "agent-run-1",
    taskId: TASK_ID,
    planId: PLAN_ID,
    workflowRunId: "workflow-run-1",
    role: "implementer",
    depth: 0,
    status: "completed",
    riskLevel: "high",
    executor: "codex",
    model: "gpt-5",
    promptVersion: "live-pipeline-test",
    permissionMode: "default",
    costUsd: 4,
    startedAt: "2026-05-10T11:00:00.000Z",
    completedAt: "2026-05-10T11:45:00.000Z",
  },
  latestLease: {
    id: "lease-1",
    taskId: TASK_ID,
    repoRoot: "/repo",
    branchName: "task-live",
    worktreePath: "/tmp/task-live",
    baseSha: "abc123def456",
    expiresAt: "2026-05-11T11:00:00.000Z",
    status: "active",
  },
  latestReviewReport: {
    id: "review-1",
    taskId: TASK_ID,
    reviewerRunId: "agent-run-1",
    outcome: "changes_requested",
    findings: [
      {
        id: "finding-1",
        severity: "high",
        title: "Add the missing guard.",
        description: "Reviewer asks for a guard around X.",
        filePath: "apps/desktop/src/renderer/routes/RunsList.tsx",
        line: 42,
        suggestedFixDirection: "Wrap the assignment in a null-check.",
      },
    ],
    createdAt: "2026-05-10T11:55:00.000Z",
  },
  taskPolicyDecisions: [],
};

const REPLAY_PAYLOAD: {
  planId: string;
  events: WorkflowEvent[];
  lastEventId: string | null;
} = {
  planId: PLAN_ID,
  events: [],
  lastEventId: null,
};

interface StubResult {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

type StubHandler = (url: URL) => StubResult;

function makeStubFetch(handler: StubHandler): {
  request: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const request: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    const result = handler(url);
    const body = result.body === undefined ? "" : JSON.stringify(result.body);
    const headers = new Headers(result.headers ?? {});
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new Response(body, {
      status: result.status ?? 200,
      headers,
    });
  };
  return { request, calls };
}

describe("desktop live read-model pipeline (mocked fetch → client → builders)", () => {
  it("hydrates the runs list with attention counts joined from the cockpit", async () => {
    const { request } = makeStubFetch((url) => {
      switch (url.pathname) {
        case "/plans":
          return { body: PLAN_LIST_PAYLOAD };
        case `/plans/${PLAN_ID}`:
          return { body: PLAN_DETAIL_PAYLOAD };
        case "/phases":
          return { body: PHASE_LIST_PAYLOAD };
        case "/tasks":
          return { body: TASK_LIST_PAYLOAD };
        case "/approvals":
          return { body: APPROVALS_PAYLOAD };
        case `/plans/${PLAN_ID}/budget-report`:
          return { body: BUDGET_PAYLOAD };
        case "/events":
          return { body: REPLAY_PAYLOAD };
        default:
          return { status: 500, body: { error: `unhandled ${url.pathname}` } };
      }
    });
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    const [plans, planDetail, phases, tasks, approvals, budget, replay] =
      await Promise.all([
        api.listPlans(),
        api.getPlan(PLAN_ID),
        api.listPhases(PLAN_ID),
        api.listTasks({ planId: PLAN_ID }),
        api.listApprovals(PLAN_ID),
        api.getBudgetReport(PLAN_ID),
        api.replayEvents(PLAN_ID),
      ]);

    const cockpit = buildRunCockpit({
      planDetail,
      phases,
      tasks,
      approvals,
      budget,
      events: replay.events,
    });
    expect(cockpit.data?.planId).toBe(PLAN_ID);
    expect(cockpit.data?.attention.pendingApprovals.value).toBe(1);
    expect(cockpit.data?.currentState.taskCountsByStatus.value).toEqual({
      in_review: 1,
    });
    // No completion audit + no release event => release stays unblocked.
    expect(cockpit.data?.release.state).toBe("no_audit");

    const summaries = buildRunSummaries({
      plans,
      cockpitByPlanId: new Map([[PLAN_ID, cockpit.data!]]),
    });
    expect(summaries.data).toHaveLength(1);
    expect(summaries.data[0]?.id).toBe(PLAN_ID);
    expect(summaries.data[0]?.attention.pendingApprovals.value).toBe(1);
    expect(summaries.data[0]?.attention.releaseReady.value).toBe(false);
    // The /plans wire payload never carries repo identity — the view
    // model must surface that as a limitation rather than fabricate one.
    expect(
      summaries.data[0]?.context.repo.limitations.map((l) => l.code),
    ).toContain("run-list-context-unavailable");
  });

  it("rebuilds the cockpit after a manual refresh that returned new attention counts", async () => {
    // First load: 1 pending approval.
    let approvalSnapshot: { planId: string; approvals: ApprovalRequest[] } =
      APPROVALS_PAYLOAD;
    const { request } = makeStubFetch((url) => {
      if (url.pathname === `/plans/${PLAN_ID}`) {
        return { body: PLAN_DETAIL_PAYLOAD };
      }
      if (url.pathname === "/approvals") {
        return { body: approvalSnapshot };
      }
      if (url.pathname === "/phases") return { body: PHASE_LIST_PAYLOAD };
      if (url.pathname === "/tasks") return { body: TASK_LIST_PAYLOAD };
      if (url.pathname === "/events") return { body: REPLAY_PAYLOAD };
      return { status: 500, body: { error: `unhandled ${url.pathname}` } };
    });
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    const firstCockpit = buildRunCockpit({
      planDetail: await api.getPlan(PLAN_ID),
      phases: await api.listPhases(PLAN_ID),
      tasks: await api.listTasks({ planId: PLAN_ID }),
      approvals: await api.listApprovals(PLAN_ID),
      events: (await api.replayEvents(PLAN_ID)).events,
    });
    expect(firstCockpit.data?.attention.pendingApprovals.value).toBe(1);

    // Simulate manual refresh — the approvals endpoint now returns no
    // pending rows. The rebuilt cockpit must reflect that without
    // changing the route's selected plan id.
    approvalSnapshot = { planId: PLAN_ID, approvals: [] };
    const refreshedApprovals = await api.listApprovals(PLAN_ID);
    const refreshedCockpit = buildRunCockpit({
      planDetail: await api.getPlan(PLAN_ID),
      phases: await api.listPhases(PLAN_ID),
      tasks: await api.listTasks({ planId: PLAN_ID }),
      approvals: refreshedApprovals,
      events: (await api.replayEvents(PLAN_ID)).events,
    });
    expect(refreshedCockpit.data?.planId).toBe(PLAN_ID);
    expect(refreshedCockpit.data?.attention.pendingApprovals.value).toBe(0);
  });

  it("maps task-detail wire payload into the renderer view model with joined lease + review", async () => {
    const { request } = makeStubFetch((url) => {
      if (url.pathname === `/tasks/${TASK_ID}`) {
        return { body: TASK_DETAIL_PAYLOAD };
      }
      return { status: 500, body: { error: `unhandled ${url.pathname}` } };
    });
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    const payload = await api.getTask(TASK_ID);
    const detail = buildTaskDetail({
      payload,
      phase: PHASE_LIST_PAYLOAD.phases[0]!,
      approvals: APPROVALS_PAYLOAD.approvals,
      budget: BUDGET_PAYLOAD,
      reviewReports: [TASK_DETAIL_PAYLOAD.latestReviewReport!],
      agentRuns: [TASK_DETAIL_PAYLOAD.latestAgentRun!],
      relatedEvents: [],
      relatedArtifacts: [],
    });
    expect(detail.data?.id).toBe(TASK_ID);
    expect(detail.data?.latestLease.value?.branchName).toBe("task-live");
    expect(detail.data?.latestReviewReport.value?.outcome).toBe(
      "changes_requested",
    );
    expect(detail.data?.acceptanceCriteria[0]?.verify).toBe(
      "pnpm --filter @pm-go/desktop test",
    );
    expect(detail.data?.worktreePath.value).toBe("/tmp/task-live");
  });

  it("falls back to a typed ApiError and lets the cockpit envelope carry the recoverable signal", async () => {
    const { request } = makeStubFetch(() => ({
      status: 503,
      body: { error: "service_unavailable", requestId: "rid-503" },
    }));
    const api = createDesktopApiClient({
      baseUrl: "http://localhost:3001",
      request,
    });

    let caught: ApiError | null = null;
    try {
      await api.listPlans();
    } catch (err) {
      if (err instanceof ApiError) caught = err;
      else throw err;
    }
    expect(caught).not.toBeNull();
    expect(caught?.recoverable).toBe(true);

    // The route would then re-issue a build with the prior plan detail
    // and the recoverable error. We mirror that here: builders must
    // mark the envelope as `partial` and keep the prior raw payload.
    const cockpit = buildRunCockpit({
      planDetail: PLAN_DETAIL_PAYLOAD,
      phases: PHASE_LIST_PAYLOAD.phases,
      tasks: TASK_LIST_PAYLOAD.tasks,
      error: {
        status: caught!.status,
        message: caught!.message,
        body: caught!.body,
        requestId: caught!.requestId,
      },
    });
    expect(cockpit.state).toBe("partial");
    expect(cockpit.errors[0]?.requestId).toBe("rid-503");
    expect(cockpit.data?.raw.planDetail).toBe(PLAN_DETAIL_PAYLOAD);
    expect(cockpit.limitations.map((l) => l.code)).toContain(
      "recoverable-api-error",
    );
  });
});
