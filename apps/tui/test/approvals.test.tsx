import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "@pm-go/contracts";

import type { ApiClient, PlanDetail } from "../src/lib/api.js";
import { TuiRuntimeProvider } from "../src/lib/context.js";
import { createQueryClient } from "../src/lib/query-client.js";
import { ApprovalsScreen } from "../src/screens/approvals.js";

const PLAN_ID = "00000000-0000-0000-0000-0000000000aa";
const TASK_A = "00000000-0000-0000-0000-0000000000bb";
const TASK_B = "00000000-0000-0000-0000-0000000000cc";

async function tick(ms = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makeApprovals(): ApprovalRequest[] {
  return [
    {
      id: "00000000-0000-0000-0000-0000000000dd",
      planId: PLAN_ID,
      taskId: TASK_A,
      subject: "task",
      riskBand: "high",
      status: "pending",
      requestedBy: "policy-engine",
      requestedAt: "2026-04-21T10:00:00.000Z",
    },
    {
      id: "00000000-0000-0000-0000-0000000000ee",
      planId: PLAN_ID,
      taskId: TASK_B,
      subject: "task",
      riskBand: "catastrophic",
      status: "approved",
      approvedBy: "tester@example.com",
      requestedAt: "2026-04-21T09:00:00.000Z",
      decidedAt: "2026-04-21T09:05:00.000Z",
    },
  ];
}

function makeApi(approvals: ApprovalRequest[]): ApiClient {
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
  };
}

function renderScreen(
  approvals: ApprovalRequest[],
  onRequestAction = vi.fn(),
  onBack = vi.fn(),
) {
  const api = makeApi(approvals);
  const queryClient = createQueryClient();
  return {
    onRequestAction,
    onBack,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TuiRuntimeProvider
          runtime={{
            api,
            config: {
              apiBaseUrl: "http://test",
              listRefreshIntervalMs: 5_000,
              eventStreamMaxBackoffMs: 500,
            },
            fetchImpl: undefined,
          }}
        >
          <ApprovalsScreen
            planId={PLAN_ID}
            onBack={onBack}
            onRequestAction={onRequestAction}
          />
        </TuiRuntimeProvider>
      </QueryClientProvider>,
    ),
  };
}

describe("ApprovalsScreen", () => {
  it("renders pending and decided sections", async () => {
    const { lastFrame, unmount } = renderScreen(makeApprovals());
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Approvals");
    expect(frame).toContain("Pending (1)");
    expect(frame).toContain("Decided (1)");
    expect(frame).toContain("high");
    expect(frame).toContain("catastrophic");
    unmount();
  });

  it("dispatches an approve-task action on enter against the cursor row", async () => {
    const onRequestAction = vi.fn();
    const { stdin, unmount } = renderScreen(
      makeApprovals(),
      onRequestAction,
    );
    await tick();
    stdin.write("\r");
    await tick();
    expect(onRequestAction).toHaveBeenCalledTimes(1);
    expect(onRequestAction).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "approve-task",
        taskId: TASK_A,
      }),
    );
    unmount();
  });

  it("renders an empty pending state when no rows are pending", async () => {
    const allDecided: ApprovalRequest[] = makeApprovals().map((a) =>
      a.status === "pending" ? { ...a, status: "approved" as const } : a,
    );
    const { lastFrame, unmount } = renderScreen(allDecided);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Pending (0)");
    expect(frame).toContain("(no pending approvals)");
    unmount();
  });

  it("calls onBack when esc is pressed", async () => {
    const onBack = vi.fn();
    const { stdin, unmount } = renderScreen(makeApprovals(), undefined, onBack);
    await tick();
    stdin.write("\u001b"); // esc
    await tick();
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });
});
