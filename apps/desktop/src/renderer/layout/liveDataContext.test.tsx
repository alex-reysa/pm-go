import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import {
  mergeRunSnapshot,
  readLiveRunSnapshot,
  readLiveRunsSnapshot,
  type StoredLiveRunResource,
} from "../App.js";
import { ApiError, type DesktopApiClient } from "../api/index.js";
import type {
  ApprovalRequest,
  BudgetReport,
  ContractPlan,
  PhaseListItem,
  PlanListItem,
  TaskListItem,
  WorkflowEvent,
} from "../read-models/index.js";
import { RunOverview } from "../routes/RunOverview.js";
import { RunsList } from "../routes/RunsList.js";
import { EventDrawer } from "./EventDrawer.js";
import { EventDrawerProvider } from "./drawerContext.js";
import {
  LiveDataProvider,
  type LiveDataContextValue,
  type LiveRunResource,
  type LiveRunsResource,
} from "./liveDataContext.js";

const planId = "11111111-1111-4111-8111-111111111111";
const phaseId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-05-11T10:00:00.000Z";
const baseUrl = "http://localhost:3001";

const plan: ContractPlan = {
  id: planId,
  specDocumentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  repoSnapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  title: "Live run",
  summary: "Run reconstructed from live API reads.",
  status: "completed",
  risks: [],
  phases: [],
  tasks: [],
  createdAt: timestamp,
  updatedAt: timestamp,
};

const planListItem: PlanListItem = {
  id: plan.id,
  title: plan.title,
  summary: plan.summary,
  status: plan.status,
  risks: plan.risks,
  completionAuditReportId: "66666666-6666-4666-8666-666666666666",
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
};

const planDetail = {
  plan,
  artifactIds: [artifactId],
  latestCompletionAudit: {
    id: "66666666-6666-4666-8666-666666666666",
    planId,
    finalPhaseId: phaseId,
    mergeRunId: "12121212-1212-4121-8121-121212121212",
    auditorRunId: "13131313-1313-4131-8131-131313131313",
    auditedHeadSha: "abc123",
    outcome: "pass" as const,
    checklist: [],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: [],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: timestamp,
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
    phaseAuditReportId: null,
    startedAt: timestamp,
    completedAt: timestamp,
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
    riskLevel: "low",
    kind: "foundation",
  },
];

const approvals: ApprovalRequest[] = [];

const budget: BudgetReport = {
  id: "88888888-8888-4888-8888-888888888888",
  planId,
  totalUsd: 1,
  totalTokens: 100,
  totalWallClockMinutes: 2,
  generatedAt: timestamp,
  perTaskBreakdown: [],
};

const releaseEvent: WorkflowEvent = {
  id: "99999999-9999-4999-8999-999999999999",
  planId,
  kind: "artifact_persisted",
  payload: {
    artifactId,
    artifactKind: "pr_summary",
    uri: "artifact://local/release.md",
  },
  createdAt: timestamp,
};

function unimplemented(method: string): never {
  throw new Error(`Unexpected API call in live data test: ${method}`);
}

function makeApi(overrides: Partial<DesktopApiClient> = {}): DesktopApiClient {
  return {
    baseUrl,
    probeHealth: async () => ({
      kind: "connected",
      envelope: {
        status: "ok",
        service: "pm-go-api",
        version: "0.8.8.0",
        instance: "desktop-test",
        port: 3001,
      },
    }),
    listPlans: async () => [planListItem],
    getPlan: async () => planDetail,
    listPhases: async () => phaseList,
    getPhase: async () => unimplemented("getPhase"),
    listTasks: async () => taskList,
    getTask: async () => unimplemented("getTask"),
    listTaskReviewReports: async () => unimplemented("listTaskReviewReports"),
    listAgentRuns: async () => unimplemented("listAgentRuns"),
    listAgentRunToolCalls: async () => unimplemented("listAgentRunToolCalls"),
    listApprovals: async () => approvals,
    getBudgetReport: async () => budget,
    replayEvents: async () => ({ events: [releaseEvent], lastEventId: releaseEvent.id }),
    createEventStreamUrl: () => `${baseUrl}/events?planId=${planId}`,
    readArtifact: async () => unimplemented("readArtifact"),
    ...overrides,
  };
}

function renderRunsList(live: LiveRunsResource): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs"]}>
      <RunsList live={live} />
    </MemoryRouter>,
  );
}

function renderRunOverview(live: StoredLiveRunResource): string {
  const resource: LiveRunResource = {
    ...live,
    refresh: () => {},
  };
  const runs: LiveRunsResource = {
    state: "ready",
    isLoading: false,
    isRefreshing: false,
    data: [],
    errors: [],
    lastUpdatedAt: timestamp,
    refresh: () => {},
  };
  const value: LiveDataContextValue = {
    runs,
    getRun: () => resource,
    ensureRun: () => {},
    refreshRun: () => {},
  };

  return renderToStaticMarkup(
    <LiveDataProvider value={value}>
      <MemoryRouter initialEntries={[`/runs/${planId}`]}>
        <Routes>
          <Route path="/runs/:planId" element={<RunOverview />} />
        </Routes>
      </MemoryRouter>
    </LiveDataProvider>,
  );
}

describe("live data read snapshots and route states", () => {
  it("maps GET /plans into live run summaries", async () => {
    const snapshot = await readLiveRunsSnapshot(makeApi());

    expect(snapshot.state).toBe("ready");
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.data[0]?.id).toBe(planId);
    expect(snapshot.data[0]?.title).toBe("Live run");
  });

  it("keeps the runs-list empty CTA hidden while live runs are loading", () => {
    const html = renderRunsList({
      state: "loading",
      isLoading: true,
      isRefreshing: false,
      data: [],
      errors: [],
      lastUpdatedAt: null,
      refresh: () => {},
    });

    expect(html).toContain('data-testid="runs-list-loading"');
    expect(html).not.toContain('data-testid="runs-list-empty"');
  });

  it("preserves last-known cockpit data when event replay refresh fails", async () => {
    const ready = mergeRunSnapshot(
      undefined,
      await readLiveRunSnapshot(makeApi(), planId),
    );
    const failedEventReplay = await readLiveRunSnapshot(
      makeApi({
        replayEvents: async () => {
          throw new ApiError(
            503,
            { error: "event replay unavailable" },
            "event replay unavailable",
          );
        },
      }),
      planId,
    );

    expect(failedEventReplay.state).toBe("partial");
    expect(failedEventReplay.endpointErrors.events?.[0]?.status).toBe(503);
    expect(failedEventReplay.release?.data.releaseArtifactIds).toEqual([]);

    const merged = mergeRunSnapshot(ready, failedEventReplay);

    expect(merged.state).toBe("partial");
    expect(merged.endpointErrors.events?.[0]?.message).toBe(
      "event replay unavailable",
    );
    expect(merged.cockpit).toBe(ready.cockpit);
    expect(merged.release?.data.releaseArtifactIds).toEqual([artifactId]);
    expect(
      merged.evidence?.data.releaseArtifacts.map((artifact) => artifact.id),
    ).toEqual([artifactId]);
    expect(merged.events?.data[0]?.id).toBe(releaseEvent.id);

    const html = renderRunOverview(merged);
    expect(html).toContain('data-source="live"');
    expect(html).toContain('data-live-state="partial"');
    expect(html).toContain('data-testid="run-overview-live-error"');
    expect(html).toContain("event replay unavailable");
    expect(html).toContain('data-testid="run-overview-event-count"');
    expect(html).not.toContain("M2 fixture");
  });

  it("does not label unrelated endpoint failures as event replay failures", async () => {
    const ready = mergeRunSnapshot(
      undefined,
      await readLiveRunSnapshot(makeApi(), planId),
    );
    const failedBudget = await readLiveRunSnapshot(
      makeApi({
        getBudgetReport: async () => {
          throw new ApiError(
            500,
            { error: "budget unavailable" },
            "budget unavailable",
          );
        },
      }),
      planId,
    );
    const merged = mergeRunSnapshot(ready, failedBudget);

    expect(merged.errors[0]?.message).toBe("budget unavailable");
    expect(merged.endpointErrors.events).toBeUndefined();

    const html = renderToStaticMarkup(
      <EventDrawerProvider initialOpen>
        <EventDrawer
          currentRouteId="run.overview"
          allowedRouteIds={["run.overview"]}
          isLive
          errors={merged.endpointErrors.events ?? []}
          events={merged.events?.data ?? []}
        />
      </EventDrawerProvider>,
    );

    expect(html).toContain('data-testid="event-drawer"');
    expect(html).not.toContain("Event replay failed");
    expect(html).toContain(`data-testid="event-drawer-event-${releaseEvent.id}"`);
  });
});
