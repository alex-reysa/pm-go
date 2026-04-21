import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  ApprovalRequest,
  Phase,
  Plan,
  Task,
  UUID,
  WorkflowEvent,
} from "@pm-go/contracts";

import { App } from "../src/app.js";
import {
  ApiError,
  type ApiClient,
  type PhaseListItem,
  type PlanDetail,
  type PlanListItem,
  type TaskListItem,
} from "../src/lib/api.js";
import { createQueryClient } from "../src/lib/query-client.js";

const PLAN_ID: UUID = "00000000-0000-0000-0000-0000000000aa";
const PHASE_ID: UUID = "00000000-0000-0000-0000-0000000000bb";
const TASK_ID: UUID = "00000000-0000-0000-0000-0000000000cc";

async function tick(ms = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makePlanListItem(): PlanListItem {
  return {
    id: PLAN_ID,
    title: "Approval flow plan",
    summary: "",
    status: "executing",
    risks: [],
    completionAuditReportId: null,
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makePlanDetail(): PlanDetail {
  const phase: Phase = {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "Phase 0",
    summary: "",
    status: "executing",
    integrationBranch: "integration/0",
    baseSnapshotId: PLAN_ID,
    taskIds: [TASK_ID],
    dependencyEdges: [],
    mergeOrder: [TASK_ID],
  };
  const task: Task = {
    id: TASK_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    slug: "t-alpha",
    title: "Alpha",
    summary: "",
    kind: "implementation",
    status: "ready_to_merge",
    riskLevel: "high",
    fileScope: { includes: ["src/"] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 30 },
    reviewerPolicy: {
      required: true,
      strictness: "elevated",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: true,
    maxReviewFixCycles: 2,
  };
  const plan: Plan = {
    id: PLAN_ID,
    specDocumentId: PLAN_ID,
    repoSnapshotId: PLAN_ID,
    title: "Approval flow plan",
    summary: "",
    status: "executing",
    phases: [phase],
    tasks: [task],
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
  return { plan, artifactIds: [], latestCompletionAudit: null };
}

function makeApi(
  approvals: ApprovalRequest[],
  overrides: Partial<ApiClient> = {},
): ApiClient {
  return {
    listPlans: async () => [makePlanListItem()] as PlanListItem[],
    getPlan: async () => makePlanDetail(),
    listPhases: async () => [] satisfies PhaseListItem[],
    listTasks: async () => [] satisfies TaskListItem[],
    listAgentRuns: async () => [] satisfies AgentRun[] as never,
    replayEvents: async () => ({ events: [] as WorkflowEvent[], lastEventId: null }),
    fetchArtifact: async () => new Response(""),
    runTask: async () => undefined,
    reviewTask: async () => undefined,
    fixTask: async () => undefined,
    integratePhase: async () => undefined,
    auditPhase: async () => undefined,
    completePlan: async () => undefined,
    releasePlan: async () => undefined,
    listApprovals: async () => approvals,
    approveTask: async () => undefined,
    approvePlan: async () => undefined,
    getBudgetReport: async () => ({
      id: "stub",
      planId: PLAN_ID,
      totalUsd: 0,
      totalTokens: 0,
      totalWallClockMinutes: 0,
      perTaskBreakdown: [],
      generatedAt: "2026-04-21T00:00:00.000Z",
    }),
    ...overrides,
  };
}

const sseStub: typeof fetch = async () =>
  new Response(new ReadableStream({ start: () => undefined }), { status: 200 });

async function openPlanDetail(stdin: { write: (s: string) => void }): Promise<void> {
  await tick();
  stdin.write("\r");
  await tick();
}

describe("operator approve — integration", () => {
  it("g A on a task with a pending approval opens the modal and fires approveTask", async () => {
    const approveTask = vi.fn(async () => undefined);
    const approvals: ApprovalRequest[] = [
      {
        id: "00000000-0000-0000-0000-0000000000dd",
        planId: PLAN_ID,
        taskId: TASK_ID,
        subject: "task",
        riskBand: "high",
        status: "pending",
        requestedBy: "policy-engine",
        requestedAt: "2026-04-21T10:00:00.000Z",
      },
    ];
    const api = makeApi(approvals, { approveTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5_000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);
    // Wait for approvals query to resolve so canApprove sees the row.
    await tick(50);

    stdin.write("g");
    stdin.write("A");
    await tick();
    expect(lastFrame() ?? "").toContain("Approve task 't-alpha'");

    stdin.write("y");
    await tick(40);
    expect(approveTask).toHaveBeenCalledTimes(1);
    expect(approveTask).toHaveBeenCalledWith(TASK_ID);
    unmount();
  });

  it("g A with no pending approval navigates to the approvals screen instead of dispatching an action", async () => {
    const approveTask = vi.fn(async () => undefined);
    const api = makeApi([], { approveTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5_000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);
    await tick(50);

    stdin.write("g");
    stdin.write("A");
    await tick(40);
    // Navigated into the approvals screen — the screen header is "Approvals".
    expect(lastFrame() ?? "").toContain("Approvals");
    expect(approveTask).not.toHaveBeenCalled();
    unmount();
  });

  it("surfaces a server 409 inline on approve and lets the operator cancel", async () => {
    const approveTask = vi.fn(async () => {
      throw new ApiError(409, {
        error: "no pending approval_requests row for task",
      });
    });
    const approvals: ApprovalRequest[] = [
      {
        id: "00000000-0000-0000-0000-0000000000ee",
        planId: PLAN_ID,
        taskId: TASK_ID,
        subject: "task",
        riskBand: "high",
        status: "pending",
        requestedBy: "policy-engine",
        requestedAt: "2026-04-21T10:00:00.000Z",
      },
    ];
    const api = makeApi(approvals, { approveTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5_000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);
    await tick(50);
    stdin.write("g");
    stdin.write("A");
    await tick();
    stdin.write("y");
    await tick(40);
    expect(approveTask).toHaveBeenCalledTimes(1);
    // Modal stays mounted, error visible inline.
    expect(lastFrame() ?? "").toContain("HTTP 409");
    // Cancel returns to plan-detail.
    stdin.write("\u001b");
    await tick();
    expect(lastFrame() ?? "").not.toContain("HTTP 409");
    unmount();
  });
});
