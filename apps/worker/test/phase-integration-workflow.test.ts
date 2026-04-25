import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Phase, Task, WorktreeLease } from "@pm-go/contracts";

const activityFns = {
  loadPhase: vi.fn(),
  loadTask: vi.fn(),
  runPhasePartitionChecks: vi.fn(),
  createIntegrationLease: vi.fn(),
  integrateTask: vi.fn(),
  validatePostMergeState: vi.fn(),
  readIntegrationWorktreeHeadSha: vi.fn(),
  capturePostMergeSnapshotAndStamp: vi.fn(),
  persistMergeRun: vi.fn(),
  markTaskMerged: vi.fn(),
  updatePhaseStatus: vi.fn(),
  releaseIntegrationLease: vi.fn(),
  // Phase 7 — approval gate + budget snapshot. Defaults pass through;
  // approval-blocked tests override evaluateApprovalGateActivity.
  evaluateApprovalGateActivity: vi.fn(async () => ({
    decision: { required: false },
  })),
  isApproved: vi.fn(async () => ({ approved: true, rejected: false })),
  persistBudgetReport: vi.fn(async () => ({ id: "budget-report-id" })),
};

let uuidCounter = 0;
// v0.8.2.1 P1.1+P1.2: the approval-gate path uses condition() to wait
// on a signal AND falls back to isApproved DB polls. Tests can drive
// the wait outcome by mutating `mockConditionResolved` (true → signal
// arrived) and the activity-level `isApproved` mock.
let mockConditionResolved = false;
const mockSetHandler = vi.fn();
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => `mock-merge-run-${++uuidCounter}`,
  setHandler: (...args: unknown[]) => mockSetHandler(...args),
  condition: async (_predicate: () => boolean, _ms?: number) =>
    mockConditionResolved,
  sleep: async (_ms: number) => undefined,
  ApplicationFailure: {
    nonRetryable: (message: string, type: string) => {
      const err = new Error(message) as Error & {
        type: string;
        nonRetryable: true;
      };
      err.type = type;
      err.nonRetryable = true;
      return err;
    },
  },
}));

const { PhaseIntegrationWorkflow } = await import(
  "../src/workflows/phase-integration.js"
);

const PHASE_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEASE_ID = "33333333-3333-4333-8333-333333333333";

function makePhase(mergeOrder: string[] = [TASK_A, TASK_B]): Phase {
  return {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "Phase 0",
    summary: "",
    status: "executing",
    integrationBranch: "integration/plan/phase-0",
    baseSnapshotId: "44444444-4444-4444-8444-444444444444",
    taskIds: [TASK_A, TASK_B],
    dependencyEdges: [],
    mergeOrder,
  };
}

function makeLease(): WorktreeLease {
  return {
    id: LEASE_ID,
    phaseId: PHASE_ID,
    kind: "integration",
    repoRoot: "/tmp/repo",
    branchName: "integration/plan/phase-0",
    worktreePath: "/tmp/integration-worktrees/plan/phase-0",
    baseSha: "a".repeat(40),
    expiresAt: "2026-04-20T00:00:00.000Z",
    status: "active",
  };
}

function makeTask(id: string): Task {
  return {
    id,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    slug: `task-${id.slice(0, 4)}`,
    title: "task",
    summary: "",
    kind: "feature",
    status: "ready_to_merge",
    riskLevel: "low",
    fileScope: { includes: [], excludes: [] },
    acceptanceCriteria: [],
    testCommands: ["pnpm test"],
    budget: { turns: 20, usd: 0.5 },
    reviewerPolicy: "required",
    requiresHumanApproval: false,
    maxReviewFixCycles: 1,
  };
}

describe("PhaseIntegrationWorkflow", () => {
  beforeEach(() => {
    for (const fn of Object.values(activityFns)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
    mockSetHandler.mockReset();
    mockConditionResolved = false;
    uuidCounter = 0;
    // Phase 7 defaults — approval gate clear, isApproved true,
    // budget snapshot succeeds. Tests that exercise the approval-blocked
    // path override evaluateApprovalGateActivity in-line.
    activityFns.evaluateApprovalGateActivity.mockResolvedValue({
      decision: { required: false },
    });
    activityFns.isApproved.mockResolvedValue({
      approved: true,
      rejected: false,
    });
    activityFns.persistBudgetReport.mockResolvedValue({
      id: "budget-report-id",
    });
  });

  it("merges every task and flips phase to auditing on happy path", async () => {
    const phase = makePhase();
    const lease = makeLease();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: true,
      reasons: [],
    });
    activityFns.createIntegrationLease.mockResolvedValue(lease);
    activityFns.loadTask.mockImplementation((input: { taskId: string }) =>
      Promise.resolve(makeTask(input.taskId)),
    );
    activityFns.integrateTask.mockResolvedValue({
      status: "merged",
      mergedHeadSha: "b".repeat(40),
    });
    activityFns.validatePostMergeState.mockResolvedValue({
      passed: true,
      logs: [],
    });
    activityFns.readIntegrationWorktreeHeadSha.mockResolvedValue("c".repeat(40));
    activityFns.capturePostMergeSnapshotAndStamp.mockResolvedValue({
      snapshotId: "snap-1",
    });

    const result = await PhaseIntegrationWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
    });

    expect(result.phaseId).toBe(PHASE_ID);
    expect(result.mergeRun.mergedTaskIds).toEqual([TASK_A, TASK_B]);
    expect(result.mergeRun.failedTaskId).toBeUndefined();
    expect(result.mergeRun.integrationHeadSha).toBe("c".repeat(40));
    expect(activityFns.markTaskMerged).toHaveBeenCalledTimes(2);
    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "integrating",
    });
    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "auditing",
    });
    expect(activityFns.persistMergeRun).toHaveBeenCalledOnce();
    // persistMergeRun MUST run before capturePostMergeSnapshotAndStamp
    // so the capture's UPDATE has a row to target. Inverting the order
    // used to silently lose the post_merge_snapshot_id linkage.
    const persistOrder =
      activityFns.persistMergeRun.mock.invocationCallOrder[0] ?? 0;
    const captureOrder =
      activityFns.capturePostMergeSnapshotAndStamp.mock
        .invocationCallOrder[0] ?? 0;
    expect(persistOrder).toBeLessThan(captureOrder);
    // Workflow must pass a deterministic snapshotId via uuid4 so
    // retries are idempotent (insert ON CONFLICT DO NOTHING,
    // UPDATE no-op).
    expect(
      activityFns.capturePostMergeSnapshotAndStamp,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mergeRunId: expect.any(String),
        snapshotId: expect.any(String),
      }),
    );
  });

  it("records failed_task_id and flips phase to blocked when a merge conflict exhausts retries", async () => {
    const phase = makePhase();
    const lease = makeLease();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: true,
      reasons: [],
    });
    activityFns.createIntegrationLease.mockResolvedValue(lease);
    activityFns.loadTask.mockImplementation((input: { taskId: string }) =>
      Promise.resolve(makeTask(input.taskId)),
    );
    // Always conflict — will exhaust MAX_MERGE_RETRY_ATTEMPTS_PER_TASK=2.
    activityFns.integrateTask.mockResolvedValue({
      status: "conflict",
      conflictedPaths: ["src/a.ts"],
    });
    activityFns.readIntegrationWorktreeHeadSha.mockResolvedValue("a".repeat(40));
    activityFns.capturePostMergeSnapshotAndStamp.mockResolvedValue({
      snapshotId: "snap-1",
    });

    const result = await PhaseIntegrationWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
    });

    expect(result.mergeRun.failedTaskId).toBe(TASK_A);
    expect(result.mergeRun.mergedTaskIds).toEqual([]);
    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "blocked",
    });
    // Snapshot capture skipped when all tasks failed — there is no
    // meaningful post-merge state to record, and the next phase's
    // base_snapshot_id stays unchanged.
    expect(
      activityFns.capturePostMergeSnapshotAndStamp,
    ).not.toHaveBeenCalled();
  });

  it("throws nonRetryable PhasePartitionInvariantError on partition violation", async () => {
    const phase = makePhase();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: false,
      reasons: ["overlap"],
    });
    activityFns.updatePhaseStatus.mockResolvedValue(undefined);

    await expect(
      PhaseIntegrationWorkflow({ planId: PLAN_ID, phaseId: PHASE_ID }),
    ).rejects.toMatchObject({
      type: "PhasePartitionInvariantError",
      nonRetryable: true,
    });

    expect(activityFns.createIntegrationLease).not.toHaveBeenCalled();
  });

  it("flips phase to failed and best-effort releases the lease on a crash post-lease", async () => {
    const phase = makePhase();
    const lease = makeLease();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: true,
      reasons: [],
    });
    activityFns.createIntegrationLease.mockResolvedValue(lease);
    activityFns.loadTask.mockResolvedValue(makeTask(TASK_A));
    activityFns.integrateTask.mockRejectedValue(new Error("git crash"));

    await expect(
      PhaseIntegrationWorkflow({ planId: PLAN_ID, phaseId: PHASE_ID }),
    ).rejects.toThrow(/git crash/);

    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: PHASE_ID,
      status: "failed",
    });
    expect(activityFns.releaseIntegrationLease).toHaveBeenCalledWith({
      leaseId: LEASE_ID,
    });
  });

  describe("v0.8.2.1 P1.1+P1.2: approval-gate race (signal vs DB poll)", () => {
    function setupApprovalRequired() {
      const phase = makePhase([TASK_A]);
      const lease = makeLease();
      activityFns.loadPhase.mockResolvedValue(phase);
      activityFns.runPhasePartitionChecks.mockResolvedValue({
        ok: true,
        reasons: [],
      });
      activityFns.createIntegrationLease.mockResolvedValue(lease);
      activityFns.loadTask.mockImplementation((input: { taskId: string }) =>
        Promise.resolve(makeTask(input.taskId)),
      );
      activityFns.evaluateApprovalGateActivity.mockResolvedValue({
        decision: { required: true, riskBand: "high" },
        approvalRequestId: "appr-1",
      });
      activityFns.integrateTask.mockResolvedValue({
        status: "merged",
        mergedHeadSha: "b".repeat(40),
      });
      activityFns.validatePostMergeState.mockResolvedValue({
        passed: true,
        logs: [],
      });
      activityFns.readIntegrationWorktreeHeadSha.mockResolvedValue("c".repeat(40));
      activityFns.capturePostMergeSnapshotAndStamp.mockResolvedValue({
        snapshotId: "snap-1",
      });
    }

    it("resolves immediately when the in-memory signal arrives (happy path)", async () => {
      setupApprovalRequired();
      mockConditionResolved = true; // signal arrived
      activityFns.isApproved.mockResolvedValue({
        approved: false,
        rejected: false,
      });

      const result = await PhaseIntegrationWorkflow({
        planId: PLAN_ID,
        phaseId: PHASE_ID,
      });

      expect(result.mergeRun.mergedTaskIds).toEqual([TASK_A]);
      // Signal short-circuits the loop — no need to poll the DB.
      expect(activityFns.isApproved).not.toHaveBeenCalled();
    });

    it("falls back to DB re-check when the signal never arrives (P1.1 backstop)", async () => {
      setupApprovalRequired();
      mockConditionResolved = false; // signal never arrived
      activityFns.isApproved.mockResolvedValue({
        approved: true,
        rejected: false,
      });

      const result = await PhaseIntegrationWorkflow({
        planId: PLAN_ID,
        phaseId: PHASE_ID,
      });

      expect(result.mergeRun.mergedTaskIds).toEqual([TASK_A]);
      // Without the row poll, the workflow would have timed out at 24h.
      expect(activityFns.isApproved).toHaveBeenCalledWith({
        approvalRequestId: "appr-1",
      });
    });

    it("recognises a rejected DB row and bails out without waiting the full timeout", async () => {
      setupApprovalRequired();
      mockConditionResolved = false; // no signal
      activityFns.isApproved.mockResolvedValue({
        approved: false,
        rejected: true,
      });

      // Rejection routes the same way as approval timeout (phase
      // blocked + nonRetryable failure). The key property is we EXIT
      // the wait promptly via the rejected branch instead of waiting
      // the full 24h. The throw confirms we exited the loop.
      await expect(
        PhaseIntegrationWorkflow({
          planId: PLAN_ID,
          phaseId: PHASE_ID,
        }),
      ).rejects.toThrow(/approval timeout/);
      expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
        phaseId: PHASE_ID,
        status: "blocked",
      });
      // Specifically: isApproved was consulted once (the rejected
      // result let us bail without re-polling).
      expect(activityFns.isApproved).toHaveBeenCalledTimes(1);
    });
  });

  it("stops merging on validatePostMergeState failure", async () => {
    const phase = makePhase();
    const lease = makeLease();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: true,
      reasons: [],
    });
    activityFns.createIntegrationLease.mockResolvedValue(lease);
    activityFns.loadTask.mockImplementation((input: { taskId: string }) =>
      Promise.resolve(makeTask(input.taskId)),
    );
    activityFns.integrateTask.mockResolvedValue({
      status: "merged",
      mergedHeadSha: "b".repeat(40),
    });
    activityFns.validatePostMergeState.mockResolvedValue({
      passed: false,
      logs: ["test failed"],
    });
    activityFns.readIntegrationWorktreeHeadSha.mockResolvedValue("a".repeat(40));
    activityFns.capturePostMergeSnapshotAndStamp.mockResolvedValue({
      snapshotId: "snap-1",
    });

    const result = await PhaseIntegrationWorkflow({
      planId: PLAN_ID,
      phaseId: PHASE_ID,
    });

    expect(result.mergeRun.failedTaskId).toBe(TASK_A);
    expect(activityFns.markTaskMerged).not.toHaveBeenCalled();
  });
});
