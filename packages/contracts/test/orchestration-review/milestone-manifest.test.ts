import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { MilestoneManifest } from "../../src/decomposition.js";
import {
  auditMilestoneManifest,
  MilestoneManifestSchema,
  validateMilestoneManifest
} from "../../src/validators/orchestration-review/milestone-manifest.js";
import { validateSpecDecomposition } from "../../src/validators/orchestration-review/spec-decomposition.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/milestone-manifest.json"
);
const fixture = JSON.parse(
  readFileSync(fixturePath, "utf8")
) as MilestoneManifest;

type _ManifestSubtypeCheck = Static<typeof MilestoneManifestSchema> extends MilestoneManifest
  ? true
  : never;
const _manifestOk: _ManifestSubtypeCheck = true;
void _manifestOk;

function clone(): MilestoneManifest {
  return JSON.parse(JSON.stringify(fixture)) as MilestoneManifest;
}

describe("validateMilestoneManifest", () => {
  it("accepts the realistic manifest fixture", () => {
    expect(validateMilestoneManifest(fixture)).toBe(true);
  });

  it("rejects a manifest with no milestones", () => {
    const mutated = clone();
    mutated.milestones = [];
    expect(validateMilestoneManifest(mutated)).toBe(false);
  });

  it("rejects a milestone id that doesn't match the m\\d{2}-slug pattern", () => {
    const mutated = clone();
    mutated.milestones[0]!.id = "milestone-one"; // missing m## prefix
    expect(validateMilestoneManifest(mutated)).toBe(false);
  });

  it("rejects a milestone with no exitCriteria", () => {
    const mutated = clone();
    mutated.milestones[0]!.exitCriteria = [];
    expect(validateMilestoneManifest(mutated)).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    const mutated = { ...fixture, unexpected: "field" };
    expect(validateMilestoneManifest(mutated)).toBe(false);
  });

  it("rejects a non-uuid specDocumentId", () => {
    const mutated = clone();
    mutated.specDocumentId = "not-a-uuid" as unknown as MilestoneManifest["specDocumentId"];
    expect(validateMilestoneManifest(mutated)).toBe(false);
  });
});

describe("auditMilestoneManifest", () => {
  it("returns no issues for the fixture manifest", () => {
    expect(auditMilestoneManifest(fixture)).toEqual([]);
  });

  it("flags duplicate milestone ids", () => {
    const mutated = clone();
    mutated.milestones[1]!.id = mutated.milestones[0]!.id;
    // Repair downstream dependency so only the duplicate trips the audit:
    mutated.milestones[2]!.dependsOn = [mutated.milestones[0]!.id];
    const issues = auditMilestoneManifest(mutated);
    expect(issues.some((i) => i.code === "DUPLICATE_MILESTONE_ID")).toBe(true);
  });

  it("flags a dependency that references a later milestone", () => {
    const mutated = clone();
    mutated.milestones[0]!.dependsOn = [mutated.milestones[2]!.id];
    const issues = auditMilestoneManifest(mutated);
    expect(
      issues.some((i) => i.code === "DEPENDENCY_REFERENCES_LATER_MILESTONE")
    ).toBe(true);
  });

  it("flags a dependency that references an unknown milestone", () => {
    const mutated = clone();
    mutated.milestones[1]!.dependsOn = ["m99-does-not-exist"];
    const issues = auditMilestoneManifest(mutated);
    expect(
      issues.some((i) => i.code === "DEPENDENCY_REFERENCES_UNKNOWN_MILESTONE")
    ).toBe(true);
  });

  it("flags self-referential dependencies", () => {
    const mutated = clone();
    mutated.milestones[1]!.dependsOn = [mutated.milestones[1]!.id];
    const issues = auditMilestoneManifest(mutated);
    expect(issues.some((i) => i.code === "DEPENDENCY_SELF_REFERENCE")).toBe(
      true
    );
  });
});

describe("validateSpecDecomposition", () => {
  it("accepts a ready decomposition wrapping the fixture manifest", () => {
    const decomposition = {
      id: "11111111-2222-4333-8444-555555555555",
      specDocumentId: fixture.specDocumentId,
      repoSnapshotId: fixture.repoSnapshotId,
      status: "ready" as const,
      manifest: fixture,
      createdAt: "2026-05-07T10:00:00.000Z",
      updatedAt: "2026-05-07T10:01:00.000Z"
    };
    expect(validateSpecDecomposition(decomposition)).toBe(true);
  });

  it("accepts a failed decomposition with errorReason and no manifest", () => {
    const decomposition = {
      id: "11111111-2222-4333-8444-555555555555",
      specDocumentId: fixture.specDocumentId,
      repoSnapshotId: fixture.repoSnapshotId,
      status: "failed" as const,
      errorReason: "decomposer hit budget cap",
      createdAt: "2026-05-07T10:00:00.000Z",
      updatedAt: "2026-05-07T10:01:00.000Z"
    };
    expect(validateSpecDecomposition(decomposition)).toBe(true);
  });

  it("rejects an unknown status literal", () => {
    const decomposition = {
      id: "11111111-2222-4333-8444-555555555555",
      specDocumentId: fixture.specDocumentId,
      repoSnapshotId: fixture.repoSnapshotId,
      status: "in-progress" as unknown as "running",
      createdAt: "2026-05-07T10:00:00.000Z",
      updatedAt: "2026-05-07T10:01:00.000Z"
    };
    expect(validateSpecDecomposition(decomposition)).toBe(false);
  });
});
