import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import { describe, expect, it } from "vitest";
import { validatePlan } from "@pm-go/contracts";
import type { Plan, SpecDocument, RepoSnapshot } from "@pm-go/contracts";

import { createFixtureSubstitutingStubRunner } from "../src/lib/fixture-stub-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
);
const specFixturePath = resolve(
  __dirname,
  "../../../packages/contracts/src/fixtures/core/spec-document.json",
);
const snapshotFixturePath = resolve(
  __dirname,
  "../../../packages/contracts/src/fixtures/core/repo-snapshot.json",
);

function loadSpec(): SpecDocument {
  return JSON.parse(readFileSync(specFixturePath, "utf8")) as SpecDocument;
}
function loadSnapshot(): RepoSnapshot {
  return JSON.parse(readFileSync(snapshotFixturePath, "utf8")) as RepoSnapshot;
}
function baseInput() {
  return {
    specDocument: loadSpec(),
    repoSnapshot: loadSnapshot(),
    systemPrompt: "test prompt",
    promptVersion: "planner@1",
    model: "claude-sonnet-4-6",
    cwd: "/tmp/fake",
  };
}

describe("createFixtureSubstitutingStubRunner", () => {
  it("rebases plan.id to specDocumentId (V1 convention)", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const input = baseInput();
    const { plan } = await runner.run(input);
    expect(plan.id).toBe(input.specDocument.id);
  });

  it("rebases plan.specDocumentId and plan.repoSnapshotId from input", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const input = baseInput();
    const { plan } = await runner.run(input);
    expect(plan.specDocumentId).toBe(input.specDocument.id);
    expect(plan.repoSnapshotId).toBe(input.repoSnapshot.id);
  });

  it("produces fresh UUIDs for every phase id and task id per run", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const first = await runner.run(baseInput());
    const second = await runner.run(baseInput());
    const firstPhaseIds = first.plan.phases.map((p) => p.id);
    const secondPhaseIds = second.plan.phases.map((p) => p.id);
    // Zero overlap between the two runs' phase ids — a stale fixture would
    // produce identical ids and break the `plan_tasks.plan_id_slug_unique`
    // constraint on the second run.
    for (const id of firstPhaseIds) {
      expect(secondPhaseIds).not.toContain(id);
    }
    const firstTaskIds = first.plan.tasks.map((t) => t.id);
    const secondTaskIds = second.plan.tasks.map((t) => t.id);
    for (const id of firstTaskIds) {
      expect(secondTaskIds).not.toContain(id);
    }
  });

  it("preserves phase->task linkage after UUID rebasing", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const { plan } = await runner.run(baseInput());
    for (const task of plan.tasks) {
      const phase = plan.phases.find((p) => p.id === task.phaseId);
      expect(phase, `task ${task.slug} references non-existent phase`).toBeDefined();
      expect(task.planId).toBe(plan.id);
    }
    for (const phase of plan.phases) {
      expect(phase.planId).toBe(plan.id);
      for (const taskId of phase.taskIds) {
        const found = plan.tasks.find((t) => t.id === taskId);
        expect(found, `phase ${phase.title} references unknown task id ${taskId}`).toBeDefined();
      }
    }
  });

  it("remaps dependencyEdge endpoints to the rebased task ids", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const { plan } = await runner.run(baseInput());
    const taskIds = new Set(plan.tasks.map((t) => t.id));
    for (const phase of plan.phases) {
      for (const edge of phase.dependencyEdges) {
        expect(taskIds.has(edge.fromTaskId), `dangling fromTaskId ${edge.fromTaskId}`).toBe(true);
        expect(taskIds.has(edge.toTaskId), `dangling toTaskId ${edge.toTaskId}`).toBe(true);
      }
    }
  });

  it("returns a plan that passes the authoritative validatePlan", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const { plan } = await runner.run(baseInput());
    expect(validatePlan(plan as Plan)).toBe(true);
  });

  it("does not mutate the fixture on disk across calls", async () => {
    const runner = createFixtureSubstitutingStubRunner(fixturePath);
    const before = readFileSync(fixturePath, "utf8");
    await runner.run(baseInput());
    await runner.run(baseInput());
    const after = readFileSync(fixturePath, "utf8");
    expect(after).toBe(before);
  });
});
