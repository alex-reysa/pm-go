import { readFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Plan,
  RepoSnapshot,
  SpecDocument,
} from "@pm-go/contracts";
import type {
  PlannerRunner,
  PlannerRunnerInput,
  PlannerRunnerResult,
} from "@pm-go/executor-claude";

import { createPlannerActivities } from "../src/activities/planner.js";

const planFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const specFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/spec-document.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));
const specFixture: SpecDocument = JSON.parse(
  readFileSync(specFixturePath, "utf8"),
);
const snapshotFixture: RepoSnapshot = {
  id: "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00",
  repoRoot: "/tmp/repo",
  defaultBranch: "main",
  headSha: "abc123",
  languageHints: ["typescript"],
  frameworkHints: [],
  buildCommands: ["pnpm build"],
  testCommands: ["pnpm test"],
  ciConfigPaths: [],
  capturedAt: "2026-04-18T10:00:00.000Z",
};

function makeMockDbForLoaders() {
  const select = vi.fn().mockImplementation(() => {
    // First select -> spec, second -> snapshot. We use a closure-scoped
    // counter to alternate the returned rows.
    const counter = select.mock.calls.length;
    const rows = counter % 2 === 1 ? [specRow()] : [snapshotRow()];
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockImplementation(() => ({
      limit,
      // drizzle's where() is also thenable for multi-row queries; the
      // planner loaders call .limit(1) so the thenable path is unused.
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    }));
    const from = vi.fn().mockImplementation(() => ({ where }));
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;

  function specRow() {
    return {
      id: specFixture.id,
      title: specFixture.title,
      source: specFixture.source,
      body: specFixture.body,
      createdAt: specFixture.createdAt,
    };
  }
  function snapshotRow() {
    return {
      id: snapshotFixture.id,
      repoRoot: snapshotFixture.repoRoot,
      repoUrl: snapshotFixture.repoUrl ?? null,
      defaultBranch: snapshotFixture.defaultBranch,
      headSha: snapshotFixture.headSha,
      languageHints: snapshotFixture.languageHints,
      frameworkHints: snapshotFixture.frameworkHints,
      buildCommands: snapshotFixture.buildCommands,
      testCommands: snapshotFixture.testCommands,
      ciConfigPaths: snapshotFixture.ciConfigPaths,
      capturedAt: snapshotFixture.capturedAt,
    };
  }
}

function makeRunner(fixture: Plan): PlannerRunner {
  return {
    async run(input: PlannerRunnerInput): Promise<PlannerRunnerResult> {
      // Echo back the spec/snapshot ids to mirror the real runner
      // contract (planner echoes the ids into the Plan).
      const plan: Plan = {
        ...fixture,
        specDocumentId: input.specDocument.id,
        repoSnapshotId: input.repoSnapshot.id,
      };
      return {
        plan,
        agentRun: {
          id: "00000000-0000-4000-8000-000000000001",
          workflowRunId: "wf-1",
          role: "planner",
          depth: 0,
          status: "completed",
          riskLevel: "low",
          executor: "claude",
          model: input.model,
          promptVersion: input.promptVersion,
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
        },
      };
    },
  };
}

describe("createPlannerActivities.generatePlan", () => {
  it("loads spec + snapshot from the db and delegates to the runner", async () => {
    const db = makeMockDbForLoaders();
    const runner = makeRunner(planFixture);
    const activities = createPlannerActivities({
      db,
      plannerRunner: runner,
      artifactDir: path.join(os.tmpdir(), "pm-go-test-artifacts"),
    });

    const out = await activities.generatePlan({
      specDocumentId: specFixture.id,
      repoSnapshotId: snapshotFixture.id,
      requestedBy: "tester",
    });

    expect(out.plan.specDocumentId).toBe(specFixture.id);
    expect(out.plan.repoSnapshotId).toBe(snapshotFixture.id);
    expect(out.agentRun.role).toBe("planner");
  });
});

describe("createPlannerActivities.renderPlanMarkdownActivity", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pm-go-artifacts-"));
  });
  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a <planId>.md artifact to artifactDir and returns the Artifact", async () => {
    const db = makeMockDbForLoaders();
    const activities = createPlannerActivities({
      db,
      plannerRunner: makeRunner(planFixture),
      artifactDir: tmpDir,
    });

    const { artifact } = await activities.renderPlanMarkdownActivity({
      planId: planFixture.id,
      plan: planFixture,
    });

    expect(artifact.planId).toBe(planFixture.id);
    expect(artifact.kind).toBe("plan_markdown");

    const expectedPath = path.join(tmpDir, `${planFixture.id}.md`);
    const written = await fsp.readFile(expectedPath, "utf8");
    expect(written).toContain("Plan ID");
    expect(written).toContain(planFixture.title);
    expect(artifact.uri).toBe(`file://${path.resolve(expectedPath)}`);
  });
});
