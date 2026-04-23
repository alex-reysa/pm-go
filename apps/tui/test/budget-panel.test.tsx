import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { BudgetReport } from "@pm-go/contracts";

import { BudgetPanel } from "../src/components/budget-panel.js";
import { waitForFrame } from "./helpers.js";
import type { ApiClient, PlanDetail } from "../src/lib/api.js";
import { TuiRuntimeProvider } from "../src/lib/context.js";
import { createQueryClient } from "../src/lib/query-client.js";

const PLAN_ID = "00000000-0000-0000-0000-0000000000aa";
const TASK_A = "00000000-0000-0000-0000-0000000000bb";
const TASK_B = "00000000-0000-0000-0000-0000000000cc";

function makeReport(): BudgetReport {
  return {
    id: "00000000-0000-0000-0000-0000000000dd",
    planId: PLAN_ID,
    totalUsd: 0.4321,
    totalTokens: 12_345,
    totalWallClockMinutes: 6.5,
    perTaskBreakdown: [
      {
        taskId: TASK_A,
        totalUsd: 0.2,
        totalTokens: 5_000,
        totalWallClockMinutes: 3,
      },
      {
        taskId: TASK_B,
        totalUsd: 0.2321,
        totalTokens: 7_345,
        totalWallClockMinutes: 3.5,
      },
    ],
    generatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeApi(report: BudgetReport): ApiClient {
  return {
    listPlans: async () => [],
    getPlan: async () => ({} as PlanDetail),
    listPhases: async () => [],
    listTasks: async () => [],
    listAgentRuns: async () => [],
    replayEvents: async () => ({ events: [], lastEventId: null }),
    fetchArtifact: async () => new Response(""),
    runTask: async () => undefined,
    reviewTask: async () => undefined,
    fixTask: async () => undefined,
    integratePhase: async () => undefined,
    auditPhase: async () => undefined,
    completePlan: async () => undefined,
    releasePlan: async () => undefined,
    listApprovals: async () => [],
    approveTask: async () => undefined,
    approvePlan: async () => undefined,
    getBudgetReport: async () => report,
  };
}

function renderPanel(report: BudgetReport) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <TuiRuntimeProvider
        runtime={{
          api: makeApi(report),
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5_000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: undefined,
        }}
      >
        <BudgetPanel planId={PLAN_ID} />
      </TuiRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("BudgetPanel", () => {
  it("renders the rolled-up totals", async () => {
    const { lastFrame, unmount } = renderPanel(makeReport());
    // All four tokens come from the same resolved query payload, so
    // polling for the final ($0.4321) is sufficient to guarantee the
    // rest are already rendered — but we check every one to match the
    // original intent and produce a readable diff on regression.
    const frame = await waitForFrame(lastFrame, [
      "Budget",
      "$0.4321",
      "12,345",
      "6.5m",
    ]);
    expect(frame).toContain("Budget");
    expect(frame).toContain("$0.4321");
    expect(frame).toContain("12,345");
    expect(frame).toContain("6.5m");
    unmount();
  });

  it("renders per-task breakdown rows", async () => {
    const { lastFrame, unmount } = renderPanel(makeReport());
    // The first 8 chars of TASK_A/TASK_B ids are visible in the breakdown rows.
    const frame = await waitForFrame(lastFrame, [
      TASK_A.slice(0, 8),
      TASK_B.slice(0, 8),
    ]);
    expect(frame).toContain(TASK_A.slice(0, 8));
    expect(frame).toContain(TASK_B.slice(0, 8));
    unmount();
  });
});
