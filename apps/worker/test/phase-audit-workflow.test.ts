import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRun,
  Phase,
  PhaseAuditReport,
  Plan,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

const activityFns = {
  loadPlan: vi.fn(),
  loadPhase: vi.fn(),
  loadNextPhase: vi.fn(),
  loadMergeRun: vi.fn(),
  runPhaseAuditor: vi.fn(),
  persistAgentRun: vi.fn(),
  persistPhaseAuditReport: vi.fn(),
  stampPhaseAuditReportId: vi.fn(),
  stampPhaseBaseSnapshotId: vi.fn(),
  fastForwardMainViaUpdateRef: vi.fn(),
  updatePhaseStatus: vi.fn(),
  releaseIntegrationLease: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => "mock-uuid",
}));

const { PhaseAuditWorkflow } = await import("../src/workflows/phase-audit.js");

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";
const MERGE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_ID = "55555555-5555-4555-8555-555555555555";
const SNAP_ID = "66666666-6666-4666-8666-666666666666";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function makePlan(): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repoSnapshotId: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "p",
    summary: "s",
    status: "executing",
    phases: [],
    tasks: [],
    risks: [],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function makePhase(): Phase {
  return {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "Phase 0",
    summary: "",
    status: "auditing",
    integrationBranch: "integration/x/phase-0",
    baseSnapshotId: "s0",
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

function makeMergeRun(overrides: Partial<StoredMergeRun> = {}): StoredMergeRun {
  return {
    id: MERGE_RUN_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    integrationBranch: "integration/x/phase-0",
    baseSha: BASE_SHA,
    mergedTaskIds: [],
    integrationHeadSha: HEAD_SHA,
    integrationLeaseId: LEASE_ID,
    postMergeSnapshotId: SNAP_ID,
    startedAt: "2026-04-19T00:00:00.000Z",
    completedAt: "2026-04-19T00:05:00.000Z",
    ...overrides,
  };
}

function makeReport(outcome: "pass" | "changes_requested" | "blocked"): PhaseAuditReport {
  return {
    id: REPORT_ID,
    phaseId: PHASE_ID,
    planId: PLAN_ID,
    mergeRunId: MERGE_RUN_ID,
    auditorRunId: "auditor-1",
    mergedHeadSha: HEAD_SHA,
    outcome,
    checklist: [],
    findings: [],
    summary: "ok",
    createdAt: "2026-04-19T00:10:00.000Z",
  };
}

function makeAgentRun(): AgentRun {
  return {
    id: "auditor-1",
    workflowRunId: "wf-1",
    role: "auditor",
    depth: 2,
    status: "completed",
    riskLevel: "low",
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "phase-auditor@1",
    permissionMode: "default",
    startedAt: "2026-04-19T00:09:00.000Z",
    completedAt: "2026-04-19T00:10:00.000Z",
  };
}

describe("PhaseAuditWorkflow", () => {
  beforeEach(() => {
    for (const fn of Object.values(activityFns)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  it("advances main + propagates snapshot + completes phase on pass", async () => {
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlan.mockResolvedValue(makePlan());
    activityFns.loadPhase.mockResolvedValue(makePhase());
    activityFns.loadNextPhase.mockResolvedValue({
      ...makePhase(),
      id: "next-phase-id",
      index: 1,
    });
    activityFns.runPhaseAuditor.mockResolvedValue({
      report: makeReport("pass"),
      agentRun: makeAgentRun(),
    });

    const result = await PhaseAuditWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      mergeRunId: MERGE_RUN_ID,
      requestedBy: "test",
    });

    expect(result.phaseReady).toBe(true);
    expect(activityFns.fastForwardMainViaUpdateRef).toHaveBeenCalledWith({
      newSha: HEAD_SHA,
      expectedCurrentSha: BASE_SHA,
    });
    expect(activityFns.stampPhaseBaseSnapshotId).toHaveBeenCalledWith({
      phaseId: "next-phase-id",
      snapshotId: SNAP_ID,
    });
    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "completed",
    });
    expect(activityFns.releaseIntegrationLease).toHaveBeenCalledWith({
      leaseId: LEASE_ID,
    });
  });

  it("does NOT advance main on changes_requested; phase → blocked", async () => {
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlan.mockResolvedValue(makePlan());
    activityFns.loadPhase.mockResolvedValue(makePhase());
    activityFns.runPhaseAuditor.mockResolvedValue({
      report: makeReport("changes_requested"),
      agentRun: makeAgentRun(),
    });

    const result = await PhaseAuditWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      mergeRunId: MERGE_RUN_ID,
      requestedBy: "test",
    });

    expect(result.phaseReady).toBe(false);
    expect(activityFns.fastForwardMainViaUpdateRef).not.toHaveBeenCalled();
    expect(activityFns.releaseIntegrationLease).not.toHaveBeenCalled();
    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "blocked",
    });
  });

  it("refuses to audit when merge_run has failed_task_id", async () => {
    activityFns.loadMergeRun.mockResolvedValue(
      makeMergeRun({ failedTaskId: "task-failed" }),
    );

    await expect(
      PhaseAuditWorkflow({
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        mergeRunId: MERGE_RUN_ID,
        requestedBy: "test",
      }),
    ).rejects.toThrow(/failed_task_id/);

    expect(activityFns.runPhaseAuditor).not.toHaveBeenCalled();
  });

  it("refuses to audit when merge_run has no integration_head_sha", async () => {
    activityFns.loadMergeRun.mockResolvedValue(
      makeMergeRun({ integrationHeadSha: undefined }),
    );

    await expect(
      PhaseAuditWorkflow({
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        mergeRunId: MERGE_RUN_ID,
        requestedBy: "test",
      }),
    ).rejects.toThrow(/integration_head_sha/);
  });

  it("does not call stampPhaseBaseSnapshotId when there is no next phase", async () => {
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlan.mockResolvedValue(makePlan());
    activityFns.loadPhase.mockResolvedValue(makePhase());
    activityFns.loadNextPhase.mockResolvedValue(null);
    activityFns.runPhaseAuditor.mockResolvedValue({
      report: makeReport("pass"),
      agentRun: makeAgentRun(),
    });

    await PhaseAuditWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      mergeRunId: MERGE_RUN_ID,
      requestedBy: "test",
    });

    expect(activityFns.stampPhaseBaseSnapshotId).not.toHaveBeenCalled();
    expect(activityFns.fastForwardMainViaUpdateRef).toHaveBeenCalled();
  });
});
