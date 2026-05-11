import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { Task, WorktreeLease } from "@pm-go/contracts";

import { buildBranchName } from "./branch-naming.js";
import { WorktreeManagerError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Input required to provision a new worktree lease for a task.
 *
 * `now` and `newUuid` are exposed purely for tests: production callers
 * should omit them so `createLease` falls back to `Date`/`randomUUID`.
 *
 * `baseSha` is the commitish to fork the agent branch from. Production
 * callers should resolve this from `phases.base_snapshot_id →
 * repo_snapshots.head_sha` so Phase N+1 worktrees branch from the
 * snapshot the orchestrator recorded for that phase (not the working
 * repo's current `HEAD`). When omitted, `createLease` falls back to
 * `HEAD` for backwards compatibility with golden-path tests and one-off
 * sample-repo flows. The supplied SHA also becomes the persisted
 * `lease.baseSha`, so downstream diff-scope reads from the same base.
 */
export interface CreateLeaseInput {
  task: Task;
  repoRoot: string;
  worktreeRoot: string;
  maxLifetimeHours: number;
  baseSha?: string;
  now?: () => Date;
  newUuid?: () => string;
}

/**
 * Create a fresh agent branch + git worktree for `task` and return the
 * resulting lease descriptor. Pure disk+git; no DB writes. Callers are
 * responsible for persisting the returned `WorktreeLease`.
 *
 * Errors are surfaced as `WorktreeManagerError` with a tagged `code` so
 * orchestrator workflows can branch on failure without parsing git
 * messages. Every git invocation goes through `execFile` to avoid the
 * shell-injection surface of `exec` with interpolated task data.
 */
export async function createLease(
  input: CreateLeaseInput,
): Promise<WorktreeLease> {
  assertIsGitRepo(input.repoRoot);

  const branchName = buildBranchName({
    planId: input.task.planId,
    taskId: input.task.id,
    slug: input.task.slug,
  });

  const sanitizedSlug = sanitizeSlugForPath(input.task.slug);
  const worktreePath = path.resolve(
    input.worktreeRoot,
    input.task.planId,
    `${input.task.id}-${sanitizedSlug}`,
  );

  if (existsSync(worktreePath)) {
    throw new WorktreeManagerError(
      "worktree-already-exists",
      `worktree path already exists: ${worktreePath}`,
    );
  }

  // When the caller threads an explicit `baseSha` (Phase N+1 task
  // worktrees do, sourced from `phases.base_snapshot_id`), fork the
  // branch from that exact commit so the diff baseline matches the
  // phase snapshot. Otherwise capture working-repo `HEAD` — keeps
  // golden-path tests and one-off sample-repo callers working without
  // touching the new code path.
  const baseSha =
    input.baseSha ?? (await captureBaseSha(input.repoRoot));
  const commitish = input.baseSha ?? "HEAD";

  try {
    await execFileAsync("git", [
      "-C",
      input.repoRoot,
      "worktree",
      "add",
      worktreePath,
      "-b",
      branchName,
      commitish,
    ]);
  } catch (err) {
    const stderr = extractStderrTail(err);
    throw new WorktreeManagerError(
      "worktree-add-failed",
      `git worktree add failed: ${stderr}`,
    );
  }

  const now = (input.now ?? (() => new Date()))();
  const expiresAt = addHoursToIso(now, input.maxLifetimeHours);
  const id = (input.newUuid ?? randomUUID)();

  return {
    id,
    taskId: input.task.id,
    repoRoot: input.repoRoot,
    branchName,
    worktreePath,
    baseSha,
    expiresAt,
    status: "active",
  };
}

/**
 * Fail fast when `repoRoot` is not a git working tree. Supports both the
 * standard `<root>/.git` directory and the `.git` file used by nested
 * worktrees (`gitdir: ...`).
 */
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

async function captureBaseSha(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "HEAD",
    ]);
    return stdout.trim();
  } catch (err) {
    const stderr = extractStderrTail(err);
    throw new WorktreeManagerError(
      "git-command-failed",
      `git rev-parse HEAD failed: ${stderr}`,
    );
  }
}

/**
 * Slug sanitizer dedicated to filesystem paths. Mirrors the safe
 * characters used by `buildBranchName`'s slug sanitizer but operates on
 * the un-prefixed slug so the resulting directory name stays portable.
 */
function sanitizeSlugForPath(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pull the tail of `stderr` from a `child_process.execFile` rejection so
 * `WorktreeManagerError.message` carries actionable context without
 * dumping multi-MB log output into the orchestrator event log.
 */
function extractStderrTail(err: unknown): string {
  if (err && typeof err === "object") {
    const maybeStderr = (err as { stderr?: unknown }).stderr;
    if (typeof maybeStderr === "string" && maybeStderr.length > 0) {
      const tail = maybeStderr.trim().split(/\r?\n/).slice(-3).join("\n");
      return tail;
    }
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return String(err);
}

/**
 * Add `hours` to `date` and return an ISO 8601 string. Fractional
 * `hours` values are honoured (3600 * 1000 ms resolution).
 */
function addHoursToIso(date: Date, hours: number): string {
  const ms = hours * 60 * 60 * 1000;
  return new Date(date.getTime() + ms).toISOString();
}
