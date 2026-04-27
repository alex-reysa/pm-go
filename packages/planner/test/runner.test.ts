import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type {
  AgentRun,
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
});
