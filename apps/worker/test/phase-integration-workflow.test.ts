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
};

let uuidCounter = 0;
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => `mock-merge-run-${++uuidCounter}`,
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
    uuidCounter = 0;
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
