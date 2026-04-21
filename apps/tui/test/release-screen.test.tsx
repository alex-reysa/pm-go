import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  CompletionAuditReport,
  Plan,
  UUID,
  WorkflowEvent,
} from "@pm-go/contracts";

import type {
  ApiClient,
  PhaseListItem,
  PlanDetail,
  PlanListItem,
  TaskListItem,
} from "../src/lib/api.js";
import { TuiRuntimeProvider } from "../src/lib/context.js";
import { createQueryClient } from "../src/lib/query-client.js";
import { ReleaseScreen } from "../src/screens/release-screen.js";

const PLAN_ID: UUID = "00000000-0000-0000-0000-0000000000aa";

async function tick(ms = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function minimalPlan(): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: PLAN_ID,
    repoSnapshotId: PLAN_ID,
    title: "Release candidate plan",
    summary: "",
    status: "completed",
    phases: [],
    tasks: [],
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeAudit(outcome: CompletionAuditReport["outcome"]): CompletionAuditReport {
  return {
    id: "audit-1",
    planId: PLAN_ID,
    finalPhaseId: "phase-final",
    mergeRunId: "merge-final",
    auditorRunId: "agent-run-audit",
    auditedHeadSha: "abcdef1234567890",
    outcome,
    checklist: [],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: ["a", "b"],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeApi(detail: PlanDetail): ApiClient {
  return {
    listPlans: async () => [] satisfies PlanListItem[],
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
  };
}

function renderScreen(detail: PlanDetail, onRequestAction = vi.fn()) {
  const api = makeApi(detail);
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <TuiRuntimeProvider
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
        }}
      >
        <ReleaseScreen
          planId={PLAN_ID}
          onBack={() => undefined}
          onRequestAction={onRequestAction}
        />
      </TuiRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("ReleaseScreen", () => {
  it("renders outcome + artifact list + release hint when eligible", async () => {
    const detail: PlanDetail = {
      plan: minimalPlan(),
      artifactIds: ["artifact-1", "artifact-2"],
      latestCompletionAudit: makeAudit("pass"),
    };
    const { lastFrame, unmount } = renderScreen(detail);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Release candidate plan");
    expect(frame).toContain("Completion audit");
    expect(frame).toContain("pass");
    expect(frame).toContain("press gR to release");
    expect(frame).toContain("artifact-1");
    expect(frame).toContain("artifact-2");
    unmount();
  });

  it("shows 'no completion audit' when latest is null", async () => {
    const detail: PlanDetail = {
      plan: minimalPlan(),
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { lastFrame, unmount } = renderScreen(detail);
    await tick();
    expect(lastFrame() ?? "").toContain("no completion audit yet");
    unmount();
  });

  it("locks release when outcome is not pass and surfaces the reason", async () => {
    const detail: PlanDetail = {
      plan: minimalPlan(),
      artifactIds: [],
      latestCompletionAudit: makeAudit("changes_requested"),
    };
    const { lastFrame, unmount } = renderScreen(detail);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("release locked");
    expect(frame).toContain("changes_requested");
    unmount();
  });

  it("fires releasePlan request when g R is pressed and eligible", async () => {
    const onRequestAction = vi.fn();
    const detail: PlanDetail = {
      plan: minimalPlan(),
      artifactIds: [],
      latestCompletionAudit: makeAudit("pass"),
    };
    const { stdin, unmount } = renderScreen(detail, onRequestAction);
    await tick();
    stdin.write("g");
    stdin.write("R");
    await tick();
    expect(onRequestAction).toHaveBeenCalledTimes(1);
    const call = onRequestAction.mock.calls[0]![0];
    expect(call.kind).toBe("release-plan");
    expect(call.planId).toBe(PLAN_ID);
    unmount();
  });
});
