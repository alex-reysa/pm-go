import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorktreeLease } from "@pm-go/contracts";

import { WorktreeManagerError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Input required to provision a per-phase integration worktree.
 *
 * `now` and `newUuid` are exposed for test determinism; production
 * callers omit them and the helper falls back to `Date`/`randomUUID`.
 */
export interface CreateIntegrationLeaseInput {
  repoRoot: string;
  integrationRoot: string;
  planId: string;
  phaseId: string;
  /** 0-indexed phase number (matches `Phase.index`). */
  phaseIndex: number;
  /** Commit to fork the integration branch from. */
  baseSha: string;
  maxLifetimeHours: number;
  now?: () => Date;
  newUuid?: () => string;
}

/**
 * Create an isolated integration worktree that `PhaseIntegrationWorkflow`
 * owns. The integration branch name is deterministic:
 *   `integration/<planId>/phase-<phaseIndex>`
 * and the on-disk path is:
 *   `<integrationRoot>/<planId>/phase-<phaseIndex>`
 *
 * Behavior:
 *   - If neither branch nor worktree exist: create branch at baseSha,
 *     add worktree, return the lease.
 *   - If branch exists and points at baseSha: idempotent reuse. Worktree
 *     is added if missing (the branch may survive a prior crash).
 *   - If branch exists and points elsewhere: throw
 *     `integration-branch-conflict`.
 *
 * Never checks out a branch inside `repoRoot` itself — `git worktree
 * add` targets a dedicated directory so the developer's working tree
 * stays on whatever branch they had.
 */
export async function createIntegrationLease(
  input: CreateIntegrationLeaseInput,
): Promise<WorktreeLease> {
  assertIsGitRepo(input.repoRoot);

  const branchName = `integration/${input.planId}/phase-${input.phaseIndex}`;
  const worktreePath = path.resolve(
    input.integrationRoot,
    input.planId,
    `phase-${input.phaseIndex}`,
  );

  const existingBranchSha = await resolveBranchSha(
    input.repoRoot,
    branchName,
  );

  if (existingBranchSha !== null && existingBranchSha !== input.baseSha) {
    throw new WorktreeManagerError(
      "integration-branch-conflict",
      `integration branch ${branchName} already points at ${existingBranchSha}, refusing to reset to ${input.baseSha}`,
    );
  }

  // Make sure the parent exists so `git worktree add` doesn't fail on
  // a missing `integrationRoot/<planId>` directory.
  await mkdir(path.dirname(worktreePath), { recursive: true });

  if (!existsSync(worktreePath)) {
    // If branch existed at baseSha we reuse it; otherwise `-b` creates it.
    const args =
      existingBranchSha === null
        ? [
            "-C",
            input.repoRoot,
            "worktree",
            "add",
            worktreePath,
            "-b",
            branchName,
            input.baseSha,
          ]
        : [
            "-C",
            input.repoRoot,
            "worktree",
            "add",
            worktreePath,
            branchName,
          ];
    try {
      await execFileAsync("git", args);
    } catch (err) {
      const stderr = extractStderrTail(err);
      throw new WorktreeManagerError(
        "worktree-add-failed",
        `git worktree add failed: ${stderr}`,
      );
    }
  }

  const now = (input.now ?? (() => new Date()))();
  const expiresAt = addHoursToIso(now, input.maxLifetimeHours);
  const id = (input.newUuid ?? randomUUID)();

  return {
    id,
    phaseId: input.phaseId,
    kind: "integration",
    repoRoot: input.repoRoot,
    branchName,
    worktreePath,
    baseSha: input.baseSha,
    expiresAt,
    status: "active",
  };
}

function assertIsGitRepo(repoRoot: string): void {
  const gitPath = path.join(repoRoot, ".git");
  if (!existsSync(gitPath)) {
    throw new WorktreeManagerError(
      "not-a-git-repo",
      `not a git repository: ${repoRoot}`,
    );
  }
  try {
    const stat = statSync(gitPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new WorktreeManagerError(
        "not-a-git-repo",
        `not a git repository: ${repoRoot}`,
      );
    }
  } catch {
    throw new WorktreeManagerError(
      "not-a-git-repo",
      `not a git repository: ${repoRoot}`,
    );
  }
}

/**
 * Return the SHA a branch currently points at, or null if the branch
 * does not exist. Falls back to `rev-parse` on the branch ref; a
 * non-zero exit implies the branch is absent.
 */
async function resolveBranchSha(
  repoRoot: string,
  branchName: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      `refs/heads/${branchName}`,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function extractStderrTail(err: unknown): string {
  if (err && typeof err === "object") {
    const maybeStderr = (err as { stderr?: unknown }).stderr;
    if (typeof maybeStderr === "string" && maybeStderr.length > 0) {
      return maybeStderr.trim().split(/\r?\n/).slice(-3).join("\n");
    }
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return String(err);
}

function addHoursToIso(date: Date, hours: number): string {
  const ms = hours * 60 * 60 * 1000;
  return new Date(date.getTime() + ms).toISOString();
}
