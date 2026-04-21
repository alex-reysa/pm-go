import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  Phase,
  Plan,
  PlanStatus,
  PhaseStatus,
  Task,
  TaskStatus,
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
    title: "Integration smoke plan",
    summary: "",
    status: "executing",
    risks: [],
    completionAuditReportId: null,
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makePlanDetail(
  phaseStatus: PhaseStatus,
  taskStatus: TaskStatus,
  planStatus: PlanStatus = "executing",
): PlanDetail {
  const phase: Phase = {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "Phase 0",
    summary: "",
    status: phaseStatus,
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
    title: "Alpha task",
    summary: "",
    kind: "implementation",
    status: taskStatus,
    riskLevel: "low",
    fileScope: { includes: ["src/"] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 30 },
    reviewerPolicy: {
      required: true,
      strictness: "standard",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 2,
  };
  const plan: Plan = {
    id: PLAN_ID,
    specDocumentId: PLAN_ID,
    repoSnapshotId: PLAN_ID,
    title: "Integration smoke plan",
    summary: "",
    status: planStatus,
    phases: [phase],
    tasks: [task],
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
  return { plan, artifactIds: [], latestCompletionAudit: null };
}

function makeApi(detail: PlanDetail, overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listPlans: async () => [makePlanListItem()] as PlanListItem[],
    getPlan: async () => detail,
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
    ...overrides,
  };
}

const sseStub: typeof fetch = async () =>
  new Response(new ReadableStream({ start: () => undefined }), { status: 200 });

async function openPlanDetail(stdin: { write: (s: string) => void }): Promise<void> {
  await tick();
  stdin.write("\r"); // enter on selected plan
  await tick();
}

describe("operator actions — integration", () => {
  it("g r on a runnable task opens the modal and fires api.runTask on confirm", async () => {
    const runTask = vi.fn(async () => undefined);
    const api = makeApi(makePlanDetail("executing", "pending"), { runTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);

    stdin.write("g");
    stdin.write("r");
    await tick();
    expect(lastFrame() ?? "").toContain("Run task 't-alpha'");

    stdin.write("y");
    await tick(40);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(TASK_ID);
    // Modal dismisses after the POST resolves → screen content returns.
    expect(lastFrame() ?? "").not.toContain("Confirm");
    expect(lastFrame() ?? "").toContain("t-alpha");
    unmount();
  });

  it("g r on a task whose phase is pending is a no-op (chord blocked by client gate)", async () => {
    const runTask = vi.fn(async () => undefined);
    const api = makeApi(makePlanDetail("pending", "pending"), { runTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);

    stdin.write("g");
    stdin.write("r");
    await tick();
    // No modal rendered → footer still visible, no "Confirm" header
    expect(lastFrame() ?? "").not.toContain("Confirm");
    expect(runTask).not.toHaveBeenCalled();
    unmount();
  });

  it("surfaces a server 409 inline in the modal and lets the operator cancel", async () => {
    const runTask = vi.fn(async () => {
      throw new ApiError(409, {
        error: "phase is 'pending'; /tasks/:id/run requires 'executing'",
      });
    });
    const api = makeApi(makePlanDetail("executing", "pending"), { runTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);
    stdin.write("g");
    stdin.write("r");
    await tick();
    stdin.write("y");
    await tick(50);

    // Error rendered inline; modal stays open for the operator's next move.
    const errFrame = lastFrame() ?? "";
    expect(errFrame).toContain("Confirm");
    expect(errFrame).toContain("HTTP 409");
    expect(errFrame).toContain("phase is 'pending'");
    expect(errFrame).toContain("y/enter confirm"); // busy cleared

    // Cancel still works → back to screen, no double-fire.
    stdin.write("n");
    await tick();
    expect(lastFrame() ?? "").not.toContain("Confirm");
    expect(runTask).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("cancel (n) closes the modal without firing the action", async () => {
    const runTask = vi.fn(async () => undefined);
    const api = makeApi(makePlanDetail("executing", "pending"), { runTask });
    const queryClient = createQueryClient();
    const { stdin, lastFrame, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
        queryClient={queryClient}
      />,
    );

    await openPlanDetail(stdin);
    stdin.write("g");
    stdin.write("r");
    await tick();
    expect(lastFrame() ?? "").toContain("Confirm");

    stdin.write("n");
    await tick();
    expect(lastFrame() ?? "").not.toContain("Confirm");
    expect(runTask).not.toHaveBeenCalled();
    unmount();
  });
});
