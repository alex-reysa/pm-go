import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type {
  AgentRun,
  MilestoneContext,
  MilestoneManifest,
  Plan,
  RepoSnapshot,
  SpecDocument,
} from "@pm-go/contracts";
import {
  createStubPlannerRunner,
  type PlannerRunner,
  type PlannerRunnerInput,
  type PlannerRunnerResult,
} from "@pm-go/executor-claude";

import { PlanValidationError, runPlanner } from "../src/runner.js";

function readFixture(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../contracts/src/fixtures/${relPath}`, import.meta.url)),
    "utf8",
  );
}

const planFixture: Plan = JSON.parse(readFixture("orchestration-review/plan.json"));
const specDocumentFixture: SpecDocument = JSON.parse(
  readFixture("core/spec-document.json"),
);
const repoSnapshotFixture: RepoSnapshot = JSON.parse(
  readFixture("core/repo-snapshot.json"),
);

describe("runPlanner", () => {
  it("invokes the injected runner with the planner prompt and returns the plan + agentRun", async () => {
    const runner = createStubPlannerRunner(planFixture);
    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
    });

    expect(result.plan).toBe(planFixture);
    expect(result.agentRun.role).toBe("planner");
    expect(result.agentRun.status).toBe("completed");
    expect(result.agentRun.model).toBe("claude-opus-4-7");
    expect(result.agentRun.promptVersion).toBe("planner@1");
  });

  it("overrides the runner-supplied plan.id when input.planId is provided, rewriting phase + task planId references in lock-step", async () => {
    // Caller-supplied id must win over whatever the runner (i.e. the
    // model) chose. This is the contract that POST /plans relies on:
    // the API generates a UUID up-front, returns it to the caller, and
    // expects the persisted row to land under that exact key.
    const apiPlanId = "deadbeef-1234-4567-89ab-cdef00112233";
    const runnerPlanFixture = JSON.parse(JSON.stringify(planFixture)) as Plan;
    expect(runnerPlanFixture.id).not.toBe(apiPlanId);

    const runner = createStubPlannerRunner(runnerPlanFixture);
    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
      planId: apiPlanId,
    });

    expect(result.plan.id).toBe(apiPlanId);
    // Phase + task `planId` references must be rewritten too — leaving
    // them pointing at the runner-supplied id would orphan the
    // children once plan-persistence writes them.
    for (const phase of result.plan.phases) {
      expect(phase.planId).toBe(apiPlanId);
    }
    for (const task of result.plan.tasks) {
      expect(task.planId).toBe(apiPlanId);
    }
  });

  it("preserves the runner-supplied plan.id when input.planId is omitted", async () => {
    const fixture = JSON.parse(JSON.stringify(planFixture)) as Plan;
    const runner = createStubPlannerRunner(fixture);
    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
    });
    expect(result.plan.id).toBe(fixture.id);
  });

  it("Claim 4 — stamps agentRun.planId when input.planId is supplied", async () => {
    // The planner AgentRun is the planner's own run record; persisting
    // it via the API requires the row land under the plan that was
    // created up-front by `POST /plans`. Without this stamp the foreign
    // key lookup against `plan_id` would resolve to NULL and
    // /plans/<id>/agent-runs would not return the planner's row.
    const apiPlanId = "deadbeef-1234-4567-89ab-cdef00112233";
    const fixture = JSON.parse(JSON.stringify(planFixture)) as Plan;
    const runner = createStubPlannerRunner(fixture);
    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
      planId: apiPlanId,
    });

    expect(result.agentRun.planId).toBe(apiPlanId);
  });

  it("Claim 4 — leaves agentRun.planId undefined when input.planId is omitted", async () => {
    const fixture = JSON.parse(JSON.stringify(planFixture)) as Plan;
    const runner = createStubPlannerRunner(fixture);
    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
    });

    expect(result.agentRun.planId).toBeUndefined();
  });

  it("strips model-supplied milestone provenance from full-spec plans", async () => {
    const fixture = {
      ...(JSON.parse(JSON.stringify(planFixture)) as Plan),
      decompositionId: "11111111-2222-4333-8444-555555555555",
      milestoneId: "M3",
    };
    const runner = createStubPlannerRunner(fixture);

    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
      planId: "deadbeef-1234-4567-89ab-cdef00112233",
    });

    expect(result.plan.decompositionId).toBeUndefined();
    expect(result.plan.milestoneId).toBeUndefined();
  });

  it("throws PlanValidationError when the runner returns an invalid plan", async () => {
    // Build a plan variant that is missing a required top-level field
    // (title). The stub just passes the fixture through, so we smuggle
    // the broken plan in via a spy runner.
    const { title, ...rest } = planFixture as Plan & Record<string, unknown>;
    void title;
    const brokenPlan = rest as unknown as Plan;

    const spy: PlannerRunner = {
      run: async (input: PlannerRunnerInput): Promise<PlannerRunnerResult> => {
        // Sanity-check that runPlanner loaded the on-disk prompt.
        expect(input.systemPrompt).toContain("pm-go software planner");
        expect(input.promptVersion).toBe("planner@1");
        expect(input.cwd).toBe(repoSnapshotFixture.repoRoot);
        const fakeRun: AgentRun = {
          id: "00000000-0000-4000-8000-000000000000",
          workflowRunId: "stub-workflow-run",
          role: "planner",
          depth: 0,
          status: "completed",
          riskLevel: "low",
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
          permissionMode: "default",
          startedAt: "2026-04-18T00:00:00.000Z",
          completedAt: "2026-04-18T00:00:01.000Z",
        };
        return { plan: brokenPlan, agentRun: fakeRun };
      },
    };

    await expect(
      runPlanner({
        specDocument: specDocumentFixture,
        repoSnapshot: repoSnapshotFixture,
        requestedBy: "alex@example.com",
        runner: spy,
      }),
    ).rejects.toBeInstanceOf(PlanValidationError);
  });

  it("stamps decompositionId + milestoneId on the returned plan when milestoneContext is provided, and forwards the context to the runner", async () => {
    const manifestFixture: MilestoneManifest = JSON.parse(
      readFixture("orchestration-review/milestone-manifest.json"),
    );
    const manifest: MilestoneManifest = {
      ...manifestFixture,
      specDocumentId: specDocumentFixture.id,
      repoSnapshotId: repoSnapshotFixture.id,
    };
    const milestoneContext: MilestoneContext = {
      decompositionId: "11111111-2222-4333-8444-555555555555",
      milestoneId: manifest.milestones[0]!.id,
      manifest,
    };

    let receivedMilestoneContext: MilestoneContext | undefined;
    const spy: PlannerRunner = {
      run: async (input: PlannerRunnerInput): Promise<PlannerRunnerResult> => {
        receivedMilestoneContext = input.milestoneContext;
        const fakeRun: AgentRun = {
          id: "00000000-0000-4000-8000-000000000002",
          workflowRunId: "stub-workflow-run",
          role: "planner",
          depth: 0,
          status: "completed",
          riskLevel: "low",
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
          permissionMode: "default",
          startedAt: "2026-05-07T00:00:00.000Z",
          completedAt: "2026-05-07T00:00:01.000Z",
        };
        return { plan: planFixture, agentRun: fakeRun };
      },
    };

    const result = await runPlanner({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner: spy,
      milestoneContext,
    });

    expect(receivedMilestoneContext).toEqual(milestoneContext);
    expect(result.plan.decompositionId).toBe(milestoneContext.decompositionId);
    expect(result.plan.milestoneId).toBe(milestoneContext.milestoneId);
  });
});
