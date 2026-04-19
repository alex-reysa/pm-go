import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIntegrationLease } from "../src/create-integration-lease.js";
import { WorktreeManagerError } from "../src/errors.js";
import { createTempGitRepo } from "./git-helpers.js";

const exec = promisify(execFile);

describe("createIntegrationLease", () => {
  let repo: { path: string; cleanup: () => Promise<void> };
  let integrationRoot: string;
  let baseSha: string;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    integrationRoot = await mkdtemp(join(tmpdir(), "pm-go-int-root-"));
    const { stdout } = await exec("git", ["-C", repo.path, "rev-parse", "HEAD"]);
    baseSha = stdout.trim();
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(integrationRoot, { recursive: true, force: true });
  });

  it("creates an isolated integration worktree + branch, leaves repoRoot HEAD untouched", async () => {
    const { stdout: beforeRef } = await exec("git", [
      "-C",
      repo.path,
      "symbolic-ref",
      "HEAD",
    ]);

    const lease = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "plan-1",
      phaseId: "phase-0-id",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });

    expect(lease.kind).toBe("integration");
    expect(lease.phaseId).toBe("phase-0-id");
    expect(lease.branchName).toBe("integration/plan-1/phase-0");
    expect(lease.worktreePath).toBe(join(integrationRoot, "plan-1", "phase-0"));
    expect(existsSync(lease.worktreePath)).toBe(true);

    // repoRoot's checked-out branch must NOT have moved (the entire
    // point of an isolated integration worktree).
    const { stdout: afterRef } = await exec("git", [
      "-C",
      repo.path,
      "symbolic-ref",
      "HEAD",
    ]);
    expect(afterRef.trim()).toBe(beforeRef.trim());
  });

  it("is idempotent: reusing existing branch at the same baseSha succeeds", async () => {
    const first = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "plan-1",
      phaseId: "phase-0-id",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });

    // Remove the worktree dir but keep the branch, simulating a crash
    // between `git worktree add` and the DB insert.
    await rm(first.worktreePath, { recursive: true, force: true });
    await exec("git", ["-C", repo.path, "worktree", "prune"]);

    const second = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "plan-1",
      phaseId: "phase-0-id",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });
    expect(second.branchName).toBe(first.branchName);
    expect(existsSync(second.worktreePath)).toBe(true);
  });

  it("refuses with integration-branch-conflict when the branch already points elsewhere", async () => {
    // Seed: create the integration branch at baseSha, then add a second
    // commit on top of it so it moves forward.
    await exec("git", [
      "-C",
      repo.path,
      "branch",
      "integration/plan-1/phase-0",
      baseSha,
    ]);
    await exec("git", [
      "-C",
      repo.path,
      "update-ref",
      "refs/heads/integration/plan-1/phase-0",
      baseSha,
    ]);
    // Create a divergent commit by checking out the branch in a temp
    // worktree, committing, then coming back.
    const tempDir = await mkdtemp(join(tmpdir(), "pm-go-divergent-"));
    await exec("git", [
      "-C",
      repo.path,
      "worktree",
      "add",
      tempDir,
      "integration/plan-1/phase-0",
    ]);
    await exec("git", ["-C", tempDir, "commit", "--allow-empty", "-m", "side"]);
    // The integration branch now points past baseSha. Remove the temp
    // worktree so createIntegrationLease doesn't see a registered one.
    await exec("git", ["-C", repo.path, "worktree", "remove", "--force", tempDir]);

    await expect(
      createIntegrationLease({
        repoRoot: repo.path,
        integrationRoot,
        planId: "plan-1",
        phaseId: "phase-0-id",
        phaseIndex: 0,
        baseSha,
        maxLifetimeHours: 1,
      }),
    ).rejects.toMatchObject({
      code: "integration-branch-conflict",
    } satisfies Partial<WorktreeManagerError>);
  });

  it("supports parallel integration leases across different phases of the same plan", async () => {
    const phase0 = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "plan-1",
      phaseId: "phase-0-id",
      phaseIndex: 0,
      baseSha,
      maxLifetimeHours: 1,
    });
    const phase1 = await createIntegrationLease({
      repoRoot: repo.path,
      integrationRoot,
      planId: "plan-1",
      phaseId: "phase-1-id",
      phaseIndex: 1,
      baseSha,
      maxLifetimeHours: 1,
    });
    expect(phase0.branchName).toBe("integration/plan-1/phase-0");
    expect(phase1.branchName).toBe("integration/plan-1/phase-1");
    expect(phase0.worktreePath).not.toBe(phase1.worktreePath);
    expect(existsSync(phase0.worktreePath)).toBe(true);
    expect(existsSync(phase1.worktreePath)).toBe(true);
  });

  it("throws not-a-git-repo when repoRoot isn't a repository", async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "pm-go-not-repo-"));
    try {
      await expect(
        createIntegrationLease({
          repoRoot: notARepo,
          integrationRoot,
          planId: "plan-1",
          phaseId: "phase-0-id",
          phaseIndex: 0,
          baseSha: "deadbeef",
          maxLifetimeHours: 1,
        }),
      ).rejects.toMatchObject({
        code: "not-a-git-repo",
      } satisfies Partial<WorktreeManagerError>);
    } finally {
      await rm(notARepo, { recursive: true, force: true });
    }
  });
});
