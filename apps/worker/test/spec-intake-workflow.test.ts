import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Plan, AgentRun, Artifact } from "@pm-go/contracts";

// The workflow module calls `proxyActivities<ActivityInterface>()` at
// module load time. Stub it to return a set of vi.fn()s we can swap in
// per-test so we can unit-test the workflow's branching without a
// Temporal test environment.
const activityFns = {
  generatePlan: vi.fn(),
  auditPlanActivity: vi.fn(),
  persistAgentRun: vi.fn(),
  persistPlan: vi.fn(),
  renderPlanMarkdownActivity: vi.fn(),
  persistArtifact: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
}));

// Import AFTER the mock so the module picks up our stubs.
const { SpecToPlanWorkflow } = await import(
  "../src/workflows/spec-intake.js"
);

const planFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));

function makeAgentRun(): AgentRun {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    workflowRunId: "wf-run-1",
    role: "planner",
    depth: 0,
    status: "completed",
    riskLevel: "low",
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "planner@1",
    permissionMode: "default",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    stopReason: "completed",
    startedAt: "2026-04-18T10:00:00.000Z",
    completedAt: "2026-04-18T10:00:01.000Z",
  };
}

function makeArtifact(): Artifact {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    planId: planFixture.id,
    kind: "plan_markdown",
    uri: "file:///tmp/plan.md",
    createdAt: "2026-04-18T10:00:02.000Z",
  };
}

beforeEach(() => {
  for (const fn of Object.values(activityFns)) fn.mockReset();
});

describe("SpecToPlanWorkflow", () => {
  it("runs plan -> persist agent run -> audit -> persist plan -> render + persist artifact (approved)", async () => {
    activityFns.generatePlan.mockResolvedValue({
      plan: planFixture,
      agentRun: makeAgentRun(),
    });
    activityFns.auditPlanActivity.mockResolvedValue({
      planId: planFixture.id,
      approved: true,
      revisionRequested: false,
      findings: [],
    });
    activityFns.persistAgentRun.mockResolvedValue(makeAgentRun().id);
    activityFns.persistPlan.mockResolvedValue({
      planId: planFixture.id,
      phaseCount: planFixture.phases.length,
      taskCount: planFixture.tasks.length,
    });
    const artifact = makeArtifact();
    activityFns.renderPlanMarkdownActivity.mockResolvedValue({ artifact });
    activityFns.persistArtifact.mockResolvedValue(artifact.id);

    const result = await SpecToPlanWorkflow({
      specDocumentId: planFixture.specDocumentId,
      repoSnapshotId: planFixture.repoSnapshotId,
      requestedBy: "test",
    });

    // Call order — `toHaveBeenCalledBefore` is not in vitest; assert via
    // invocation-timestamp comparison on the mock.invocationCallOrder.
    const order = [
      activityFns.generatePlan.mock.invocationCallOrder[0],
      activityFns.persistAgentRun.mock.invocationCallOrder[0],
      activityFns.auditPlanActivity.mock.invocationCallOrder[0],
      activityFns.persistPlan.mock.invocationCallOrder[0],
      activityFns.renderPlanMarkdownActivity.mock.invocationCallOrder[0],
      activityFns.persistArtifact.mock.invocationCallOrder[0],
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }

    // persistPlan receives the plan stamped with status='approved'.
    expect(activityFns.persistPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: planFixture.id, status: "approved" }),
    );

    expect(result.plan.status).toBe("approved");
    expect(result.renderedPlanArtifactId).toBe(artifact.id);
  });

  it("marks the plan as blocked and skips render/persistArtifact when audit rejects", async () => {
    activityFns.generatePlan.mockResolvedValue({
      plan: planFixture,
      agentRun: makeAgentRun(),
    });
    activityFns.auditPlanActivity.mockResolvedValue({
      planId: planFixture.id,
      approved: false,
      revisionRequested: true,
      findings: [
        {
          id: "plan_audit.phases.index_sequence",
          severity: "high",
          title: "out of sequence",
          summary: "bad",
          filePath: "plan.phases",
          confidence: 1,
          suggestedFixDirection: "fix",
        },
      ],
    });
    activityFns.persistAgentRun.mockResolvedValue(makeAgentRun().id);
    activityFns.persistPlan.mockResolvedValue({
      planId: planFixture.id,
      phaseCount: planFixture.phases.length,
      taskCount: planFixture.tasks.length,
    });

    const result = await SpecToPlanWorkflow({
      specDocumentId: planFixture.specDocumentId,
      repoSnapshotId: planFixture.repoSnapshotId,
      requestedBy: "test",
    });

    expect(activityFns.renderPlanMarkdownActivity).not.toHaveBeenCalled();
    expect(activityFns.persistArtifact).not.toHaveBeenCalled();
    expect(activityFns.persistPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: planFixture.id, status: "blocked" }),
    );
    expect(result.plan.status).toBe("blocked");
    expect(result.renderedPlanArtifactId).toBeUndefined();
  });
});
