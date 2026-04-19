import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Phase, Task } from "@pm-go/contracts";

const activityFns = {
  loadPhase: vi.fn(),
  loadPhaseTasks: vi.fn(),
  runPhasePartitionChecks: vi.fn(),
  updatePhaseStatus: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => "mock-uuid",
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

const { PhasePartitionWorkflow } = await import(
  "../src/workflows/phase-partition.js"
);

function makePhase(): Phase {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    planId: "22222222-2222-4222-8222-222222222222",
    index: 0,
    title: "Phase 0",
    summary: "",
    status: "integrating",
    integrationBranch: "integration/x/phase-0",
    baseSnapshotId: "33333333-3333-4333-8333-333333333333",
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

describe("PhasePartitionWorkflow", () => {
  beforeEach(() => {
    for (const fn of Object.values(activityFns)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  it("returns phase tasks unchanged when invariants hold", async () => {
    const phase = makePhase();
    const tasks: Task[] = [];
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: true,
      reasons: [],
    });
    activityFns.loadPhaseTasks.mockResolvedValue(tasks);

    const result = await PhasePartitionWorkflow({
      planId: phase.planId,
      phaseId: phase.id,
    });

    expect(result).toEqual({
      planId: phase.planId,
      phaseId: phase.id,
      partitionedTasks: tasks,
    });
    expect(activityFns.updatePhaseStatus).not.toHaveBeenCalled();
  });

  it("throws PhasePartitionInvariantError and flips phase to blocked on violation", async () => {
    const phase = makePhase();
    activityFns.loadPhase.mockResolvedValue(phase);
    activityFns.runPhasePartitionChecks.mockResolvedValue({
      ok: false,
      reasons: ["fileScope overlap a,b"],
    });
    activityFns.updatePhaseStatus.mockResolvedValue(undefined);

    await expect(
      PhasePartitionWorkflow({ planId: phase.planId, phaseId: phase.id }),
    ).rejects.toMatchObject({
      type: "PhasePartitionInvariantError",
      nonRetryable: true,
    });

    expect(activityFns.updatePhaseStatus).toHaveBeenCalledWith({
      phaseId: phase.id,
      status: "blocked",
    });
  });
});
