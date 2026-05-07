import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  MilestoneManifest,
  SpecDecomposition,
} from "@pm-go/contracts";

const activityFns = {
  initSpecDecomposition: vi.fn(),
  markSpecDecompositionRunning: vi.fn(),
  runDecomposerActivity: vi.fn(),
  finalizeSpecDecompositionReady: vi.fn(),
  finalizeSpecDecompositionFailed: vi.fn(),
  persistAgentRun: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  // The workflow imports `ApplicationFailure` from @temporalio/workflow;
  // its `.create` static returns the constructed error so the catch
  // path can `throw` it. Stubbed to a plain Error subclass so the
  // assertion `await expect(...).rejects.toThrow(...)` works under the
  // mocked module.
  ApplicationFailure: {
    create: (input: { message: string; type?: string }) => {
      const err = new Error(input.message);
      err.name = input.type ?? "ApplicationFailure";
      return err;
    },
  },
}));

const { SpecDecompositionWorkflow } = await import(
  "../src/workflows/spec-decomposition.js"
);

const manifestFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/milestone-manifest.json",
    import.meta.url,
  ),
);
const manifest: MilestoneManifest = JSON.parse(
  readFileSync(manifestFixturePath, "utf8"),
);

function makeAgentRun(): AgentRun {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workflowRunId: "wf-run-1",
    role: "planner",
    depth: 0,
    status: "completed",
    riskLevel: "low",
    executor: "claude",
    model: "claude-opus-4-7",
    promptVersion: "decomposer@1",
    permissionMode: "default",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    stopReason: "completed",
    outputFormatSchemaRef: "MilestoneManifest@1",
    startedAt: "2026-05-07T10:00:00.000Z",
    completedAt: "2026-05-07T10:00:01.000Z",
  };
}

function makeDecomposition(
  status: SpecDecomposition["status"],
  extras: Partial<SpecDecomposition> = {},
): SpecDecomposition {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    specDocumentId: manifest.specDocumentId,
    repoSnapshotId: manifest.repoSnapshotId,
    status,
    createdAt: "2026-05-07T10:00:00.000Z",
    updatedAt: "2026-05-07T10:00:01.000Z",
    ...extras,
  };
}

beforeEach(() => {
  for (const fn of Object.values(activityFns)) fn.mockReset();
});

describe("SpecDecompositionWorkflow", () => {
  it("init -> running -> run -> persist agent run -> finalize ready (happy path)", async () => {
    activityFns.runDecomposerActivity.mockResolvedValue({
      manifest,
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue(makeAgentRun().id);
    activityFns.finalizeSpecDecompositionReady.mockResolvedValue(
      makeDecomposition("ready", { manifest }),
    );

    const result = await SpecDecompositionWorkflow({
      decompositionId: "30000000-0000-4000-8000-000000000001",
      specDocumentId: manifest.specDocumentId,
      repoSnapshotId: manifest.repoSnapshotId,
      requestedBy: "test",
    });

    const order = [
      activityFns.initSpecDecomposition.mock.invocationCallOrder[0],
      activityFns.markSpecDecompositionRunning.mock.invocationCallOrder[0],
      activityFns.runDecomposerActivity.mock.invocationCallOrder[0],
      activityFns.persistAgentRun.mock.invocationCallOrder[0],
      activityFns.finalizeSpecDecompositionReady.mock.invocationCallOrder[0],
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }

    expect(activityFns.finalizeSpecDecompositionFailed).not.toHaveBeenCalled();
    expect(result.decomposition.status).toBe("ready");
    expect(result.decomposition.manifest).toEqual(manifest);
  });

  it("calls finalizeSpecDecompositionFailed and rethrows when the decomposer activity fails", async () => {
    activityFns.runDecomposerActivity.mockRejectedValue(
      new Error("manifest validation failed: missing milestones"),
    );
    activityFns.finalizeSpecDecompositionFailed.mockResolvedValue(
      makeDecomposition("failed", {
        errorReason: "manifest validation failed: missing milestones",
      }),
    );

    await expect(
      SpecDecompositionWorkflow({
        decompositionId: "30000000-0000-4000-8000-000000000001",
        specDocumentId: manifest.specDocumentId,
        repoSnapshotId: manifest.repoSnapshotId,
        requestedBy: "test",
      }),
    ).rejects.toThrow(/manifest validation failed/);

    expect(activityFns.finalizeSpecDecompositionFailed).toHaveBeenCalledWith({
      decompositionId: "30000000-0000-4000-8000-000000000001",
      errorReason: "manifest validation failed: missing milestones",
    });
    expect(activityFns.persistAgentRun).not.toHaveBeenCalled();
    expect(activityFns.finalizeSpecDecompositionReady).not.toHaveBeenCalled();
  });

  it("flips the row to failed when persistAgentRun throws after a successful decomposer run", async () => {
    activityFns.runDecomposerActivity.mockResolvedValue({
      manifest,
      agentRun: makeAgentRun(),
    });
    // Worker 4's persistAgentRun has used up its retry budget — surface
    // as a synthetic failure to the workflow.
    activityFns.persistAgentRun.mockRejectedValue(
      new Error("DB unreachable"),
    );
    activityFns.finalizeSpecDecompositionFailed.mockResolvedValue(
      makeDecomposition("failed", { errorReason: "DB unreachable" }),
    );

    await expect(
      SpecDecompositionWorkflow({
        decompositionId: "30000000-0000-4000-8000-000000000001",
        specDocumentId: manifest.specDocumentId,
        repoSnapshotId: manifest.repoSnapshotId,
        requestedBy: "test",
      }),
    ).rejects.toThrow(/DB unreachable/);

    // Row was flipped to failed despite the persist crash — no row
    // stuck at `running` for the operator to discover later.
    expect(activityFns.finalizeSpecDecompositionFailed).toHaveBeenCalledWith({
      decompositionId: "30000000-0000-4000-8000-000000000001",
      errorReason: "DB unreachable",
    });
    expect(activityFns.finalizeSpecDecompositionReady).not.toHaveBeenCalled();
  });

  it("flips the row to failed when finalizeSpecDecompositionReady itself throws", async () => {
    activityFns.runDecomposerActivity.mockResolvedValue({
      manifest,
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue(makeAgentRun().id);
    activityFns.finalizeSpecDecompositionReady.mockRejectedValue(
      new Error("CHECK constraint violation"),
    );
    activityFns.finalizeSpecDecompositionFailed.mockResolvedValue(
      makeDecomposition("failed", {
        errorReason: "CHECK constraint violation",
      }),
    );

    await expect(
      SpecDecompositionWorkflow({
        decompositionId: "30000000-0000-4000-8000-000000000001",
        specDocumentId: manifest.specDocumentId,
        repoSnapshotId: manifest.repoSnapshotId,
        requestedBy: "test",
      }),
    ).rejects.toThrow(/CHECK constraint/);

    expect(activityFns.finalizeSpecDecompositionFailed).toHaveBeenCalledWith({
      decompositionId: "30000000-0000-4000-8000-000000000001",
      errorReason: "CHECK constraint violation",
    });
  });
});
