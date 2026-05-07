import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type {
  MilestoneManifest,
  RepoSnapshot,
  SpecDocument,
} from "@pm-go/contracts";
import {
  createStubDecomposerRunner,
  type DecomposerRunner,
  type DecomposerRunnerInput,
  type DecomposerRunnerResult,
} from "@pm-go/executor-claude";

import {
  MilestoneManifestValidationError,
  runDecomposer,
} from "../src/decomposer-runner.js";

function readFixture(relPath: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../contracts/src/fixtures/${relPath}`, import.meta.url),
    ),
    "utf8",
  );
}

const specDocumentFixture: SpecDocument = JSON.parse(
  readFixture("core/spec-document.json"),
);
const repoSnapshotFixture: RepoSnapshot = JSON.parse(
  readFixture("core/repo-snapshot.json"),
);
const manifestFixtureRaw: MilestoneManifest = JSON.parse(
  readFixture("orchestration-review/milestone-manifest.json"),
);

function manifestForFixtures(): MilestoneManifest {
  // The shipped fixture has placeholder spec/snapshot ids so it stays
  // self-contained for contract tests. For runDecomposer we need a
  // manifest whose ids match the SpecDocument / RepoSnapshot fixtures
  // so the cross-id assertion succeeds; the structural and audit
  // checks are the real subject under test here.
  //
  // Deep-clone so per-test mutations (dependsOn rewrites etc.) don't
  // bleed across test cases via the shared module-level fixture.
  const cloned = JSON.parse(JSON.stringify(manifestFixtureRaw)) as MilestoneManifest;
  cloned.specDocumentId = specDocumentFixture.id;
  cloned.repoSnapshotId = repoSnapshotFixture.id;
  return cloned;
}

describe("runDecomposer", () => {
  it("returns the runner's manifest + AgentRun on the happy path", async () => {
    const manifest = manifestForFixtures();
    const runner = createStubDecomposerRunner(manifest);
    const result = await runDecomposer({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner,
    });
    expect(result.manifest).toEqual(manifest);
    expect(result.agentRun.role).toBe("planner");
    expect(result.agentRun.promptVersion).toBe("decomposer@1");
    expect(result.agentRun.outputFormatSchemaRef).toBe("MilestoneManifest@1");
  });

  it("loads the decomposer system prompt from disk", async () => {
    let capturedSystemPrompt = "";
    const spy: DecomposerRunner = {
      run: async (
        input: DecomposerRunnerInput,
      ): Promise<DecomposerRunnerResult> => {
        capturedSystemPrompt = input.systemPrompt;
        expect(input.promptVersion).toBe("decomposer@1");
        expect(input.cwd).toBe(repoSnapshotFixture.repoRoot);
        return {
          manifest: manifestForFixtures(),
          agentRun: {
            id: "00000000-0000-4000-8000-000000000001",
            workflowRunId: "stub",
            role: "planner",
            depth: 0,
            status: "completed",
            riskLevel: "low",
            executor: "claude",
            model: input.model,
            promptVersion: input.promptVersion,
            permissionMode: "default",
            outputFormatSchemaRef: "MilestoneManifest@1",
            startedAt: "2026-05-07T10:00:00.000Z",
            completedAt: "2026-05-07T10:00:01.000Z",
          },
        };
      },
    };
    await runDecomposer({
      specDocument: specDocumentFixture,
      repoSnapshot: repoSnapshotFixture,
      requestedBy: "alex@example.com",
      runner: spy,
    });
    expect(capturedSystemPrompt).toContain("pm-go milestone decomposer");
  });

  it("throws MilestoneManifestValidationError when the runner returns a structurally invalid manifest", async () => {
    const broken = {
      ...manifestForFixtures(),
      milestones: [],
    } as unknown as MilestoneManifest;
    const runner = createStubDecomposerRunner(broken);
    await expect(
      runDecomposer({
        specDocument: specDocumentFixture,
        repoSnapshot: repoSnapshotFixture,
        requestedBy: "alex@example.com",
        runner,
      }),
    ).rejects.toBeInstanceOf(MilestoneManifestValidationError);
  });

  it("throws MilestoneManifestValidationError when the manifest fails the topology audit", async () => {
    const cyclic = manifestForFixtures();
    // Make milestone[0] depend on milestone[2] — forward reference
    // that the audit will flag as DEPENDENCY_REFERENCES_LATER_MILESTONE.
    cyclic.milestones[0]!.dependsOn = [cyclic.milestones[2]!.id];
    const runner = createStubDecomposerRunner(cyclic);
    await expect(
      runDecomposer({
        specDocument: specDocumentFixture,
        repoSnapshot: repoSnapshotFixture,
        requestedBy: "alex@example.com",
        runner,
      }),
    ).rejects.toBeInstanceOf(MilestoneManifestValidationError);
  });

  it("throws when the manifest's specDocumentId does not match the input", async () => {
    const driftedSpec = manifestForFixtures();
    driftedSpec.specDocumentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const runner = createStubDecomposerRunner(driftedSpec);
    await expect(
      runDecomposer({
        specDocument: specDocumentFixture,
        repoSnapshot: repoSnapshotFixture,
        requestedBy: "alex@example.com",
        runner,
      }),
    ).rejects.toThrow(/specDocumentId/);
  });

  it("throws when the manifest's repoSnapshotId does not match the input", async () => {
    const driftedSnap = manifestForFixtures();
    driftedSnap.repoSnapshotId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const runner = createStubDecomposerRunner(driftedSnap);
    await expect(
      runDecomposer({
        specDocument: specDocumentFixture,
        repoSnapshot: repoSnapshotFixture,
        requestedBy: "alex@example.com",
        runner,
      }),
    ).rejects.toThrow(/repoSnapshotId/);
  });
});
