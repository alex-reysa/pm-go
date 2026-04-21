import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { AgentRun, Plan, UUID, WorkflowEvent } from "@pm-go/contracts";

import { App } from "../src/app.js";
import type {
  ApiClient,
  PhaseListItem,
  PlanDetail,
  PlanListItem,
  TaskListItem,
} from "../src/lib/api.js";
import { createQueryClient } from "../src/lib/query-client.js";

/**
 * Small no-op api client for tests. Every endpoint resolves with the
 * shape the real server would return; writes resolve void. Overrides
 * let individual tests swap in richer data.
 */
function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  const plans: PlanListItem[] = [];
  return {
    listPlans: async () => plans,
    getPlan: async (planId) =>
      ({
        plan: minimalPlan(planId),
        artifactIds: [],
        latestCompletionAudit: null,
      }) satisfies PlanDetail,
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

function minimalPlan(planId: UUID): Plan {
  return {
    id: planId,
    specDocumentId: planId,
    repoSnapshotId: "00000000-0000-0000-0000-000000000000",
    title: "Under test",
    summary: "",
    status: "approved",
    phases: [],
    tasks: [],
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

async function tick(ms = 20): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("App", () => {
  it("renders the plans list and moves the cursor with j/k", async () => {
    const fakePlans: PlanListItem[] = [
      {
        id: "00000000-0000-0000-0000-00000000000a",
        title: "Alpha release plan",
        summary: "",
        status: "approved",
        risks: [],
        completionAuditReportId: null,
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T01:00:00.000Z",
      },
      {
        id: "00000000-0000-0000-0000-00000000000b",
        title: "Beta release plan",
        summary: "",
        status: "executing",
        risks: [],
        completionAuditReportId: null,
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T00:30:00.000Z",
      },
    ];
    const api = makeApi({ listPlans: async () => fakePlans });
    const queryClient = createQueryClient();
    const { lastFrame, stdin, unmount } = render(
      <App
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
        }}
        queryClient={queryClient}
      />,
    );

    await tick();
    const frame1 = lastFrame() ?? "";
    expect(frame1).toContain("Alpha release plan");
    expect(frame1).toContain("Beta release plan");
    // First row should be selected (▶ marker).
    const alphaLine = frame1.split("\n").find((l) => l.includes("Alpha"))!;
    expect(alphaLine).toContain("▶");

    stdin.write("j");
    await tick();
    const frame2 = lastFrame() ?? "";
    const betaLine = frame2.split("\n").find((l) => l.includes("Beta"))!;
    expect(betaLine).toContain("▶");

    unmount();
  });

  it("navigates to plan detail on enter and returns on esc", async () => {
    const planId = "00000000-0000-0000-0000-00000000000a";
    const fakePlans: PlanListItem[] = [
      {
        id: planId,
        title: "Alpha release plan",
        summary: "",
        status: "approved",
        risks: [],
        completionAuditReportId: null,
        createdAt: "2026-04-21T00:00:00.000Z",
        updatedAt: "2026-04-21T01:00:00.000Z",
      },
    ];
    // Stub SSE via runtime.fetchImpl — the plan-detail screen subscribes
    // to /events through useEventStream, which reads fetchImpl off the
    // runtime. Returning an empty-forever stream idles the loop without
    // blocking test shutdown.
    const sseStub: typeof fetch = async () =>
      new Response(new ReadableStream({ start: () => undefined }), {
        status: 200,
      });

    const api = makeApi({ listPlans: async () => fakePlans });
    const queryClient = createQueryClient();
    const { lastFrame, stdin, unmount } = render(
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

    await tick();
    stdin.write("\r");
    await tick(40);
    expect(lastFrame() ?? "").toContain("Worker 3 fills this");

    stdin.write("\u001B"); // esc
    await tick(40);
    expect(lastFrame() ?? "").toContain("Alpha release plan");

    unmount();
  });
});
