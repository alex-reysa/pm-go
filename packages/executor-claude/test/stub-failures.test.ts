import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import {
  createStubImplementerRunner,
  createStubReviewerRunner,
  resolveImplementerStubFailureMode,
  resolveReviewerStubFailureMode,
  tryMergeBranchOntoMain,
  wrapImplementerRunnerWithFailureMode,
  wrapReviewerRunnerWithFailureMode,
} from "../src/index.js";

const execFile = promisify(execFileCb);

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    planId: "6d1f4c3a-5f2b-4e27-9d8c-9a7f1b2c3d4e",
    phaseId: "11111111-2222-4333-8444-555555555555",
    slug: "chaos-task",
    title: "Chaos task",
    summary: "Phase 7 chaos harness test task.",
    kind: "foundation",
    status: "running",
    riskLevel: "low",
    fileScope: { includes: ["phase7-chaos/marker.txt"] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 10 },
    reviewerPolicy: {
      required: false,
      strictness: "standard",
      maxCycles: 1,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mode-resolver unit tests — the cheapest possible surface-area check
// that env-var parsing is deterministic and doesn't leak between tests.
// ---------------------------------------------------------------------------

describe("resolveImplementerStubFailureMode", () => {
  it("returns undefined when unset", () => {
    expect(resolveImplementerStubFailureMode(undefined)).toBeUndefined();
    expect(resolveImplementerStubFailureMode("")).toBeUndefined();
  });
  it("accepts merge_conflict and worker_kill", () => {
    expect(resolveImplementerStubFailureMode("merge_conflict")).toBe(
      "merge_conflict",
    );
    expect(resolveImplementerStubFailureMode("worker_kill")).toBe("worker_kill");
  });
  it("ignores unknown values", () => {
    expect(resolveImplementerStubFailureMode("review_rejection")).toBeUndefined();
    expect(resolveImplementerStubFailureMode("random")).toBeUndefined();
  });
});

describe("resolveReviewerStubFailureMode", () => {
  it("returns undefined when unset", () => {
    expect(resolveReviewerStubFailureMode(undefined)).toBeUndefined();
  });
  it("accepts review_rejection", () => {
    expect(resolveReviewerStubFailureMode("review_rejection")).toBe(
      "review_rejection",
    );
  });
  it("ignores implementer-side modes", () => {
    expect(resolveReviewerStubFailureMode("merge_conflict")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wrapper behaviour tests. We use the `mode` option explicitly rather
// than setting process.env — keeps each test hermetic.
// ---------------------------------------------------------------------------

describe("wrapImplementerRunnerWithFailureMode — pass-through", () => {
  it("returns the inner runner unchanged when no mode is active", async () => {
    const inner = createStubImplementerRunner();
    const wrapped = wrapImplementerRunnerWithFailureMode(inner);
    expect(wrapped).toBe(inner);
  });
});

describe("wrapImplementerRunnerWithFailureMode — merge_conflict", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), "pm-go-chaos-impl-"));
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    await execFile("git", ["config", "user.email", "stub@example.com"], {
      cwd: worktree,
    });
    await execFile("git", ["config", "user.name", "Stub"], { cwd: worktree });
    await execFile("git", ["commit", "--allow-empty", "-m", "init", "-q"], {
      cwd: worktree,
    });
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("stages a conflicting commit on main; merge of the task branch reports conflict", async () => {
    // Create a task branch, let the stub write its version there, then
    // wrap and run — the wrapper stages the conflicting commit on main.
    await execFile("git", ["checkout", "-b", "task-branch"], { cwd: worktree });

    const inner = createStubImplementerRunner({
      writeFile: {
        relativePath: "phase7-chaos/marker.txt",
        contents: "task branch content\n",
      },
    });
    const wrapped = wrapImplementerRunnerWithFailureMode(inner, {
      mode: "merge_conflict",
    });
    const result = await wrapped.run({
      task: buildTask({ slug: "chaos-merge" }),
      worktreePath: worktree,
      baseSha: "deadbeef",
      systemPrompt: "sp",
      promptVersion: "chaos",
      model: "claude-sonnet-4-6",
    });
    expect(result.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);

    // Now attempt to merge the task branch into main. The wrapper has
    // committed conflicting bytes on main, so we should see a conflict.
    const outcome = await tryMergeBranchOntoMain(worktree, "task-branch");
    expect(outcome.status).toBe("conflict");
    if (outcome.status === "conflict") {
      expect(outcome.conflictedPaths).toContain("phase7-chaos/marker.txt");
    }
  });
});

describe("wrapImplementerRunnerWithFailureMode — worker_kill", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), "pm-go-chaos-kill-"));
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    await execFile("git", ["config", "user.email", "stub@example.com"], {
      cwd: worktree,
    });
    await execFile("git", ["config", "user.name", "Stub"], { cwd: worktree });
    await execFile("git", ["commit", "--allow-empty", "-m", "init", "-q"], {
      cwd: worktree,
    });
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("writes a partial file, then surfaces a thrown error via the test hook (no process.exit)", async () => {
    const inner = createStubImplementerRunner({
      writeFile: {
        relativePath: "phase7-chaos/marker.txt",
        contents: "complete content\n",
      },
    });
    const wrapped = wrapImplementerRunnerWithFailureMode(inner, {
      mode: "worker_kill",
      // Test hook replaces process.exit so vitest doesn't die.
      onWorkerKill: () => {
        throw new Error("worker_kill hook fired");
      },
    });

    await expect(
      wrapped.run({
        task: buildTask({ slug: "chaos-kill" }),
        worktreePath: worktree,
        baseSha: "deadbeef",
        systemPrompt: "sp",
        promptVersion: "chaos",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/worker_kill/);

    // The partial file must be on disk so we can observe it from the
    // harness (durable state between the kill and the restart).
    const written = await readFile(
      path.join(worktree, "phase7-chaos/marker.txt"),
      "utf8",
    );
    expect(written).toContain("partial worker_kill payload");
  });
});

describe("wrapReviewerRunnerWithFailureMode — review_rejection", () => {
  it("returns a high-severity finding on every call when active", async () => {
    const inner = createStubReviewerRunner({ sequence: ["pass"] });
    const wrapped = wrapReviewerRunnerWithFailureMode(inner, {
      mode: "review_rejection",
    });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const result = await wrapped.run({
        task: buildTask(),
        worktreePath: "/tmp/unused",
        baseSha: "deadbeef",
        headSha: "cafebabe".repeat(5),
        strictness: "standard",
        systemPrompt: "sp",
        promptVersion: "chaos",
        model: "claude-sonnet-4-6",
        cycleNumber: cycle,
      });
      expect(result.report.outcome).toBe("changes_requested");
      expect(result.report.findings[0]?.severity).toBe("high");
    }
  });

  it("is a transparent pass-through when no mode is active", () => {
    const inner = createStubReviewerRunner({ sequence: ["pass"] });
    const wrapped = wrapReviewerRunnerWithFailureMode(inner);
    expect(wrapped).toBe(inner);
  });
});
