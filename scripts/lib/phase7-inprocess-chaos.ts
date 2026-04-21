/**
 * Phase 7 chaos harness — in-process driver.
 *
 * Drives a single task through one of three failure modes and writes a
 * durable-state snapshot to PHASE7_CHAOS_STATE_FILE so the outer bash
 * harness can assert the expected transitions without a real Postgres
 * or Temporal stack.
 *
 * Modes (resolved from env):
 *   IMPLEMENTER_STUB_FAILURE=merge_conflict
 *   IMPLEMENTER_STUB_FAILURE=worker_kill
 *   REVIEWER_STUB_FAILURE=review_rejection
 *
 * Expected durable state (written to PHASE7_CHAOS_STATE_FILE):
 *   merge_conflict   → { taskStatus: "blocked", blockedReason: "merge_conflict", conflictedPaths, retries }
 *   worker_kill      → { taskStatus: "ready_to_merge" (after resume),
 *                         killObservedAtStatus: "running", resumed: true, headSha }
 *   review_rejection → { taskStatus: "blocked", blockedReason: "review_cycles_exceeded",
 *                         cyclesAttempted, maxCycles }
 *
 * These JSON shapes mirror (in miniature) the plan_tasks + policy
 * breadcrumb rows Worker 4 will persist in integration. The chaos
 * harness does NOT persist to DB — DB assertion is Worker 4's job.
 */
import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Task } from "../../packages/contracts/src/index.js";
import {
  createStubImplementerRunner,
  createStubReviewerRunner,
  tryMergeBranchOntoMain,
  wrapImplementerRunnerWithFailureMode,
  wrapReviewerRunnerWithFailureMode,
} from "../../packages/executor-claude/src/index.js";

const execFile = promisify(execFileCb);

const FIXTURE_REPO = process.env.PHASE7_FIXTURE_REPO;
const CHAOS_MODE = process.env.PHASE7_CHAOS_MODE;
if (!FIXTURE_REPO || !CHAOS_MODE) {
  console.error(
    "[phase7-chaos] PHASE7_FIXTURE_REPO and PHASE7_CHAOS_MODE must be set",
  );
  process.exit(2);
}

const STATE_FILE =
  process.env.PHASE7_CHAOS_STATE_FILE ??
  path.join(FIXTURE_REPO!, ".phase7-chaos-state.json");

const MERGE_RETRY_CAP = Number(
  process.env.IMPLEMENTER_STUB_FAILURE_RETRY_CAP ?? "2",
);
const REVIEW_CYCLE_CAP = Number(
  process.env.REVIEWER_STUB_FAILURE_CYCLE_CAP ?? "2",
);

function buildTask(slug: string): Task {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    planId: "6d1f4c3a-5f2b-4e27-9d8c-9a7f1b2c3d4e",
    phaseId: "11111111-2222-4333-8444-555555555555",
    slug,
    title: `chaos ${slug}`,
    summary: `Phase 7 chaos task for slug=${slug}`,
    kind: "foundation",
    status: "pending",
    riskLevel: "low",
    fileScope: { includes: [`phase7-chaos/${slug}.txt`] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 10 },
    reviewerPolicy: {
      required: false,
      strictness: "standard",
      maxCycles: REVIEW_CYCLE_CAP,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: REVIEW_CYCLE_CAP,
  };
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Mode: merge_conflict
// ---------------------------------------------------------------------------

async function runMergeConflict(): Promise<void> {
  const slug = "merge-conflict";
  const task = buildTask(slug);
  const branch = `chaos/${slug}`;
  await execFile("git", ["checkout", "-b", branch], { cwd: FIXTURE_REPO! });

  // Build wrapped implementer with merge_conflict mode active.
  const inner = createStubImplementerRunner({
    writeFile: {
      relativePath: `phase7-chaos/${slug}.txt`,
      contents: "task-branch content\n",
    },
  });
  const wrapped = wrapImplementerRunnerWithFailureMode(inner);

  // Retry loop: the orchestrator's RetryPolicy would normally handle
  // this. We model the retry budget ourselves so the harness is
  // assertion-complete without spinning up Temporal.
  let attempts = 0;
  let conflictedPaths: string[] = [];
  let outcomeStatus: "blocked" | "clean" = "blocked";
  while (attempts < MERGE_RETRY_CAP) {
    attempts += 1;

    // Reset branch state between attempts so each retry starts from a
    // clean merge base. In production this would be a fresh worktree
    // lease — same effect.
    await execFile("git", ["checkout", branch], { cwd: FIXTURE_REPO! });

    await wrapped.run({
      task,
      worktreePath: FIXTURE_REPO!,
      baseSha: "0000000000000000000000000000000000000000",
      systemPrompt: "sp",
      promptVersion: "chaos",
      model: "claude-sonnet-4-6",
    });

    const merge = await tryMergeBranchOntoMain(FIXTURE_REPO!, branch);
    if (merge.status === "clean") {
      outcomeStatus = "clean";
      break;
    }
    conflictedPaths = merge.conflictedPaths;
  }

  // Durable assertion: after retry exhaustion the task must be
  // `blocked`, NOT silently succeeding.
  await writeState({
    mode: "merge_conflict",
    taskStatus: outcomeStatus === "clean" ? "ready_to_merge" : "blocked",
    blockedReason: outcomeStatus === "clean" ? undefined : "merge_conflict",
    conflictedPaths,
    retries: attempts,
    retryCap: MERGE_RETRY_CAP,
  });

  if (outcomeStatus === "clean") {
    throw new Error(
      "[chaos/merge_conflict] merge unexpectedly succeeded — failure mode did not fire",
    );
  }
  console.log(
    `[chaos] merge_conflict: task=blocked conflictedPaths=${conflictedPaths.join(",")} retries=${attempts}/${MERGE_RETRY_CAP}`,
  );
}

// ---------------------------------------------------------------------------
// Mode: review_rejection
// ---------------------------------------------------------------------------

async function runReviewRejection(): Promise<void> {
  const slug = "review-rejection";
  const task = buildTask(slug);
  const branch = `chaos/${slug}`;
  await execFile("git", ["checkout", "-b", branch], { cwd: FIXTURE_REPO! });

  // Implementer side: always passes (no failure mode). We just want to
  // get a commit on the branch so the reviewer loop has something to
  // review.
  const implementer = createStubImplementerRunner({
    writeFile: {
      relativePath: `phase7-chaos/${slug}.txt`,
      contents: "reviewable content\n",
    },
  });
  const implResult = await implementer.run({
    task,
    worktreePath: FIXTURE_REPO!,
    baseSha: "0000000000000000000000000000000000000000",
    systemPrompt: "sp",
    promptVersion: "chaos",
    model: "claude-sonnet-4-6",
  });
  if (!implResult.finalCommitSha) {
    throw new Error(
      "[chaos/review_rejection] implementer did not produce a commit",
    );
  }

  // Reviewer side: wrapped with review_rejection, so every cycle fails
  // with a high-severity finding. Loop until the cap is exceeded.
  const inner = createStubReviewerRunner({ sequence: ["pass"] });
  const reviewer = wrapReviewerRunnerWithFailureMode(inner);

  let cyclesAttempted = 0;
  let lastOutcome = "pass";
  for (let cycle = 1; cycle <= REVIEW_CYCLE_CAP; cycle += 1) {
    cyclesAttempted = cycle;
    const result = await reviewer.run({
      task,
      worktreePath: FIXTURE_REPO!,
      baseSha: "0000000000000000000000000000000000000000",
      headSha: implResult.finalCommitSha,
      strictness: "standard",
      systemPrompt: "sp",
      promptVersion: "chaos",
      model: "claude-sonnet-4-6",
      cycleNumber: cycle,
      workflowRunId: `chaos-${randomUUID()}`,
    });
    lastOutcome = result.report.outcome;
    if (result.report.outcome === "pass") break;
  }

  const blocked = lastOutcome !== "pass";
  await writeState({
    mode: "review_rejection",
    taskStatus: blocked ? "blocked" : "ready_to_merge",
    blockedReason: blocked ? "review_cycles_exceeded" : undefined,
    cyclesAttempted,
    maxCycles: REVIEW_CYCLE_CAP,
    lastOutcome,
    // Breadcrumb shape mirroring Worker 1's PolicyDecision contract so
    // the bash harness can assert against it.
    policyDecisionHint: blocked
      ? { stop: true, reason: "review_cycles_exceeded" }
      : { stop: false },
  });

  if (!blocked) {
    throw new Error(
      "[chaos/review_rejection] reviewer unexpectedly passed — failure mode did not fire",
    );
  }
  console.log(
    `[chaos] review_rejection: task=blocked cycles=${cyclesAttempted}/${REVIEW_CYCLE_CAP} reason=review_cycles_exceeded`,
  );
}

// ---------------------------------------------------------------------------
// Mode: worker_kill
//
// Runs *this same script* twice as sub-processes:
//   pass 1: IMPLEMENTER_STUB_FAILURE=worker_kill (exits 137)
//   pass 2: PHASE7_CHAOS_RESUME=1 (no failure env — clean completion)
//
// Between passes the task status stays "running" (durable). After
// pass 2 the task flips to "ready_to_merge". The outer driver (this
// function) reads both sub-process exits, aggregates into the state
// file, and asserts the shape.
// ---------------------------------------------------------------------------

async function runWorkerKillDriver(): Promise<void> {
  // If we're the resume child, do the clean pass and exit.
  if (process.env.PHASE7_CHAOS_RESUME === "1") {
    await workerKillResumePass();
    return;
  }
  // If we're the kill child (IMPLEMENTER_STUB_FAILURE is set), do the
  // kill and exit. This code path is only hit when the outer bash
  // script invokes us with the failure env set — NOT when the driver
  // recurses.
  if (process.env.IMPLEMENTER_STUB_FAILURE === "worker_kill") {
    await workerKillKillPass();
    return; // unreachable — worker_kill exits 137
  }

  // Driver pass (no failure env, no resume env). Spawn the two child
  // phases and aggregate.
  const slug = "worker-kill";
  const branch = `chaos/${slug}`;
  await execFile("git", ["checkout", "-b", branch], { cwd: FIXTURE_REPO! });

  // --- pass 1: kill ------------------------------------------------------
  const killChild = await spawnSelf({
    IMPLEMENTER_STUB_FAILURE: "worker_kill",
    PHASE7_CHAOS_MODE: "worker_kill",
    PHASE7_FIXTURE_REPO: FIXTURE_REPO!,
    PHASE7_CHAOS_STATE_FILE: STATE_FILE,
    PHASE7_CHAOS_BRANCH: branch,
  });
  const killedNonZero = killChild.exitCode !== 0;
  // While pass-1 ran, the task was still `running` — we simulate that
  // via a transient snapshot written by the kill pass itself.

  // --- pass 2: resume ----------------------------------------------------
  const resumeChild = await spawnSelf({
    PHASE7_CHAOS_RESUME: "1",
    PHASE7_CHAOS_MODE: "worker_kill",
    PHASE7_FIXTURE_REPO: FIXTURE_REPO!,
    PHASE7_CHAOS_STATE_FILE: STATE_FILE,
    PHASE7_CHAOS_BRANCH: branch,
  });
  if (resumeChild.exitCode !== 0) {
    throw new Error(
      `[chaos/worker_kill] resume pass exited ${resumeChild.exitCode}; harness cannot assert recovery`,
    );
  }

  // Aggregate: the resume child has already written the final state.
  // Patch in the pre-resume transition for observability.
  // Load → modify → rewrite.
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(STATE_FILE, "utf8");
  const state = JSON.parse(raw) as Record<string, unknown>;
  state.killPassExitCode = killChild.exitCode;
  state.killPassNonZero = killedNonZero;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");

  console.log(
    `[chaos] worker_kill: kill exit=${killChild.exitCode} resumed task=${String(state.taskStatus)}`,
  );
}

async function workerKillKillPass(): Promise<void> {
  const slug = "worker-kill";
  const task = buildTask(slug);
  const branch = process.env.PHASE7_CHAOS_BRANCH ?? `chaos/${slug}`;
  await execFile("git", ["checkout", branch], { cwd: FIXTURE_REPO! });

  // Record transient "running" state BEFORE the kill fires so the
  // driver can see the in-flight status.
  await writeState({
    mode: "worker_kill",
    taskStatus: "running",
    killObservedAtStatus: "running",
    resumed: false,
  });

  const inner = createStubImplementerRunner({
    writeFile: {
      relativePath: `phase7-chaos/${slug}.txt`,
      contents: "complete content\n",
    },
  });
  const wrapped = wrapImplementerRunnerWithFailureMode(inner);
  await wrapped.run({
    task,
    worktreePath: FIXTURE_REPO!,
    baseSha: "0000000000000000000000000000000000000000",
    systemPrompt: "sp",
    promptVersion: "chaos",
    model: "claude-sonnet-4-6",
  });
  // Unreachable — worker_kill exits 137 mid-run.
}

async function workerKillResumePass(): Promise<void> {
  const slug = "worker-kill";
  const task = buildTask(slug);
  const branch = process.env.PHASE7_CHAOS_BRANCH ?? `chaos/${slug}`;
  await execFile("git", ["checkout", branch], { cwd: FIXTURE_REPO! });

  // No failure env set → inner stub runs normally and commits the
  // full file, overwriting the partial payload from pass 1.
  const implementer = createStubImplementerRunner({
    writeFile: {
      relativePath: `phase7-chaos/${slug}.txt`,
      contents: "complete content\n",
    },
  });
  const implResult = await implementer.run({
    task,
    worktreePath: FIXTURE_REPO!,
    baseSha: "0000000000000000000000000000000000000000",
    systemPrompt: "sp",
    promptVersion: "chaos",
    model: "claude-sonnet-4-6",
  });
  if (!implResult.finalCommitSha) {
    throw new Error(
      "[chaos/worker_kill] resume pass did not produce a final commit",
    );
  }

  await writeState({
    mode: "worker_kill",
    taskStatus: "ready_to_merge",
    killObservedAtStatus: "running",
    resumed: true,
    headSha: implResult.finalCommitSha,
  });
}

// ---------------------------------------------------------------------------
// Child-process helper.
// ---------------------------------------------------------------------------

async function spawnSelf(
  env: Record<string, string>,
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    // fileURLToPath (rather than `new URL(...).pathname`) correctly
    // decodes URL-escaped characters like spaces in the working
    // directory — `pnpm exec tsx` will otherwise fail with
    // ERR_MODULE_NOT_FOUND if the repo root contains " ".
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn("pnpm", ["-s", "exec", "tsx", selfPath], {
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve({ exitCode: code }));
  });
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (CHAOS_MODE === "merge_conflict") return runMergeConflict();
  if (CHAOS_MODE === "review_rejection") return runReviewRejection();
  if (CHAOS_MODE === "worker_kill") return runWorkerKillDriver();
  throw new Error(`[phase7-chaos] unknown mode '${CHAOS_MODE}'`);
}

main().catch((err: unknown) => {
  console.error(`[phase7-chaos] FAILED mode=${CHAOS_MODE}`);
  console.error(err);
  process.exit(1);
});
