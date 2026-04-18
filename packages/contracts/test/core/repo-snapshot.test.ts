import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RepoSnapshot } from "../../src/execution.js";
import { repoSnapshotFixturePath } from "../../src/fixtures/core/index.js";
import {
  RepoSnapshotSchema,
  validateRepoSnapshot,
  type RepoSnapshotStatic
} from "../../src/validators/core/repo-snapshot.js";

function loadFixture(): unknown {
  return JSON.parse(readFileSync(repoSnapshotFixturePath, "utf8"));
}

describe("RepoSnapshot contract", () => {
  it("accepts the canonical fixture", () => {
    const fixture = loadFixture();
    expect(validateRepoSnapshot(fixture)).toBe(true);
  });

  it("accepts the fixture with the optional `repoUrl` removed", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    delete fixture["repoUrl"];
    expect(validateRepoSnapshot(fixture)).toBe(true);
  });

  it("rejects a fixture whose required `defaultBranch` is wrongly typed", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["defaultBranch"] = 42;
    expect(validateRepoSnapshot(fixture)).toBe(false);
  });

  it("rejects a fixture whose `languageHints` array contains a non-string", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["languageHints"] = ["TypeScript", 123];
    expect(validateRepoSnapshot(fixture)).toBe(false);
  });

  it("rejects a fixture missing the required `headSha` field", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    delete fixture["headSha"];
    expect(validateRepoSnapshot(fixture)).toBe(false);
  });

  it("exposes a TypeBox schema with the expected $id", () => {
    expect(RepoSnapshotSchema.$id).toBe("RepoSnapshot");
  });

  it("has a Static<> type structurally compatible with RepoSnapshot", () => {
    const sample: RepoSnapshotStatic = {
      id: "2e8b3c4d-5a6f-4b7c-8d9e-0f1a2b3c4d5e",
      repoRoot: "/tmp/example-repo",
      defaultBranch: "main",
      headSha: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b",
      languageHints: ["TypeScript"],
      frameworkHints: ["Node.js"],
      buildCommands: ["pnpm build"],
      testCommands: ["pnpm test"],
      ciConfigPaths: [".github/workflows/ci.yml"],
      capturedAt: "2026-04-18T10:35:12.000Z"
    };
    const asContract: RepoSnapshot = sample;
    expect(asContract.id).toBe(sample.id);
  });
});
