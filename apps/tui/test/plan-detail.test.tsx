import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  CompletionAuditReport,
  Phase,
  Plan,
  Task,
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
import { PlanDetailScreen } from "../src/screens/plan-detail.js";

const PLAN_ID: UUID = "00000000-0000-0000-0000-0000000000aa";
const PHASE_0: UUID = "00000000-0000-0000-0000-0000000000b0";
const PHASE_1: UUID = "00000000-0000-0000-0000-0000000000b1";
const TASK_A: UUID = "00000000-0000-0000-0000-0000000000c0";
const TASK_B: UUID = "00000000-0000-0000-0000-0000000000c1";
const TASK_C: UUID = "00000000-0000-0000-0000-0000000000c2";

async function tick(ms = 25): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function makePhase(id: UUID, index: number, title: string): Phase {
  return {
    id,
    planId: PLAN_ID,
    index,
    title,
    summary: "",
    status: "executing",
    integrationBranch: `integration/${index}`,
    baseSnapshotId: PLAN_ID,
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

function makeTask(id: UUID, phaseId: UUID, slug: string): Task {
  return {
    id,
    planId: PLAN_ID,
    phaseId,
    slug,
    title: `Title ${slug}`,
    summary: "",
    kind: "implementation",
    status: "pending",
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
}

function makePlan(phases: Phase[], tasks: Task[]): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: PLAN_ID,
    repoSnapshotId: PLAN_ID,
    title: "Two-phase plan",
    summary: "",
    status: "executing",
    phases,
    tasks,
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
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
    listApprovals: async () => [],
    approveTask: async () => undefined,
    approvePlan: async () => undefined,
    getBudgetReport: async (planId) => ({
      id: "budget-stub",
      planId,
      totalUsd: 0,
      totalTokens: 0,
      totalWallClockMinutes: 0,
      perTaskBreakdown: [],
      generatedAt: "2026-04-21T00:00:00.000Z",
    }),
  };
}

const sseStub: typeof fetch = async () =>
  new Response(new ReadableStream({ start: () => undefined }), { status: 200 });

function renderScreen(detail: PlanDetail, callbacks = {}) {
  const onBack = vi.fn();
  const onNavigate = vi.fn();
  const onRequestAction = vi.fn();
  const onDisabledKindsChange = vi.fn();
  const api = makeApi(detail);
  const queryClient = createQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TuiRuntimeProvider
        runtime={{
          api,
          config: {
            apiBaseUrl: "http://test",
            listRefreshIntervalMs: 5000,
            eventStreamMaxBackoffMs: 500,
          },
          fetchImpl: sseStub,
        }}
      >
        <PlanDetailScreen
          planId={PLAN_ID}
          onBack={onBack}
          onNavigate={onNavigate}
          onRequestAction={onRequestAction}
          onDisabledKindsChange={onDisabledKindsChange}
          {...callbacks}
        />
      </TuiRuntimeProvider>
    </QueryClientProvider>,
  );
  return { ...result, onBack, onNavigate, onRequestAction, onDisabledKindsChange };
}

describe("PlanDetailScreen", () => {
  it("renders phase cards + task rows grouped by phase", async () => {
    const detail: PlanDetail = {
      plan: makePlan(
        [makePhase(PHASE_0, 0, "Core"), makePhase(PHASE_1, 1, "Polish")],
        [
          makeTask(TASK_A, PHASE_0, "t-alpha"),
          makeTask(TASK_B, PHASE_0, "t-beta"),
          makeTask(TASK_C, PHASE_1, "t-gamma"),
        ],
      ),
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { lastFrame, unmount } = renderScreen(detail);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Two-phase plan");
    expect(frame).toContain("Core");
    expect(frame).toContain("Polish");
    expect(frame).toContain("t-alpha");
    expect(frame).toContain("t-beta");
    expect(frame).toContain("t-gamma");
    unmount();
  });

  it("cursor j moves to the next task", async () => {
    const detail: PlanDetail = {
      plan: makePlan(
        [makePhase(PHASE_0, 0, "Core")],
        [makeTask(TASK_A, PHASE_0, "t-alpha"), makeTask(TASK_B, PHASE_0, "t-beta")],
      ),
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { stdin, lastFrame, unmount } = renderScreen(detail);
    await tick();
    const framePre = lastFrame() ?? "";
    // Selected chevron next to t-alpha initially.
    expect(framePre.split("\n").find((l) => l.includes("t-alpha"))).toContain("▶");

    stdin.write("j");
    await tick();
    const framePost = lastFrame() ?? "";
    expect(framePost.split("\n").find((l) => l.includes("t-beta"))).toContain("▶");
    unmount();
  });

  it("enter on a task navigates to the task drawer", async () => {
    const detail: PlanDetail = {
      plan: makePlan(
        [makePhase(PHASE_0, 0, "Core")],
        [makeTask(TASK_A, PHASE_0, "t-alpha")],
      ),
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { stdin, onNavigate, unmount } = renderScreen(detail);
    await tick();
    stdin.write("\r");
    await tick();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith({
      name: "task",
      planId: PLAN_ID,
      taskId: TASK_A,
    });
    unmount();
  });

  it("shows the Release row only when a completion audit exists", async () => {
    const audit: CompletionAuditReport = {
      id: "audit-1",
      planId: PLAN_ID,
      finalPhaseId: PHASE_0,
      mergeRunId: "merge-1",
      auditorRunId: "agent-run-audit",
      auditedHeadSha: "abc",
      outcome: "pass",
      checklist: [],
      findings: [],
      summary: {
        acceptanceCriteriaPassed: [],
        acceptanceCriteriaMissing: [],
        openFindingIds: [],
        unresolvedPolicyDecisionIds: [],
      },
      createdAt: "2026-04-21T00:00:00.000Z",
    };
    const detailWith: PlanDetail = {
      plan: makePlan([], []),
      artifactIds: [],
      latestCompletionAudit: audit,
    };
    const detailWithout: PlanDetail = {
      plan: makePlan([], []),
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { lastFrame: frameWith, unmount: unmountWith } = renderScreen(detailWith);
    await tick();
    expect(frameWith() ?? "").toContain("Release");
    unmountWith();

    const { lastFrame: frameWithout, unmount: unmountWithout } =
      renderScreen(detailWithout);
    await tick();
    expect(frameWithout() ?? "").not.toContain("Release");
    unmountWithout();
  });

  it("reports disabled chord kinds based on current plan/task state", async () => {
    // Phase pending → run-task blocked; task pending (not in_review) → review blocked;
    // plan has no phases? No, plan has one pending phase → complete-plan blocked.
    const detail: PlanDetail = {
      plan: {
        ...makePlan(
          [{ ...makePhase(PHASE_0, 0, "Core"), status: "pending" }],
          [makeTask(TASK_A, PHASE_0, "t-alpha")],
        ),
      },
      artifactIds: [],
      latestCompletionAudit: null,
    };
    const { onDisabledKindsChange, unmount } = renderScreen(detail);
    await tick(40);
    // Last call carries the latest snapshot of disabled kinds.
    const calls = onDisabledKindsChange.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const latest = calls[calls.length - 1]![0] as string[];
    expect(latest).toContain("run-task");
    expect(latest).toContain("review-task");
    expect(latest).toContain("fix-task");
    expect(latest).toContain("complete-plan");
    expect(latest).toContain("release-plan");
    unmount();
  });
});
