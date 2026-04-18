import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan, RepoSnapshot, SpecDocument } from "@pm-go/contracts";
import { createStubPlannerRunner } from "../src/index.js";

// Load the Plan fixture directly off disk, mirroring the precedent in
// packages/db/test/round-trip.test.ts and apps/worker/test/spec-intake.test.ts.
const planFixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));

const specDocument: SpecDocument = {
  id: planFixture.specDocumentId,
  title: "stub spec",
  source: "manual",
  body: "stub body",
  createdAt: "2026-04-15T09:00:00.000Z",
};

const repoSnapshot: RepoSnapshot = {
  id: planFixture.repoSnapshotId,
  repoRoot: "/tmp/repo",
  defaultBranch: "main",
  headSha: "deadbeef",
  languageHints: [],
  frameworkHints: [],
  buildCommands: [],
  testCommands: [],
  ciConfigPaths: [],
  capturedAt: "2026-04-15T09:00:00.000Z",
};

describe("createStubPlannerRunner", () => {
  it("returns the fixture Plan plus a synthesized planner AgentRun", async () => {
    const runner = createStubPlannerRunner(planFixture);
    const result = await runner.run({
      specDocument,
      repoSnapshot,
      systemPrompt: "system prompt",
      promptVersion: "1",
      model: "claude-sonnet-4-6",
      cwd: "/tmp/repo",
    });

    expect(result.plan).toBe(planFixture);
    expect(result.agentRun.role).toBe("planner");
    expect(result.agentRun.status).toBe("completed");
    expect(result.agentRun.stopReason).toBe("completed");
    expect(result.agentRun.turns).toBe(0);
    expect(result.agentRun.inputTokens).toBe(0);
    expect(result.agentRun.outputTokens).toBe(0);
    expect(result.agentRun.costUsd).toBe(0);
    expect(result.agentRun.sessionId).toBe("stub-session");
    expect(result.agentRun.model).toBe("claude-sonnet-4-6");
    expect(result.agentRun.promptVersion).toBe("1");
    expect(result.agentRun.startedAt).toBeDefined();
    expect(result.agentRun.completedAt).toBeDefined();
  });
});
