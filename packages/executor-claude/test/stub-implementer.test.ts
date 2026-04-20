import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";

import { createStubImplementerRunner } from "../src/index.js";

const execFileAsync = promisify(execFile);

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    planId: "6d1f4c3a-5f2b-4e27-9d8c-9a7f1b2c3d4e",
    phaseId: "11111111-2222-4333-8444-555555555555",
    slug: "stub-task",
    title: "Stub task",
    summary: "Stub task for unit tests.",
    kind: "foundation",
    status: "running",
    riskLevel: "low",
    fileScope: { includes: ["**/*"] },
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

describe("createStubImplementerRunner", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), "pm-go-stub-impl-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("no-op mode returns a valid implementer AgentRun with no commit sha", async () => {
    const runner = createStubImplementerRunner();
    const result = await runner.run({
      task: buildTask(),
      worktreePath: worktree,
      baseSha: "deadbeef",
      systemPrompt: "sp",
      promptVersion: "1",
      model: "claude-sonnet-4-6",
    });

    expect(result.finalCommitSha).toBeUndefined();
    expect(result.agentRun.role).toBe("implementer");
    expect(result.agentRun.status).toBe("completed");
    expect(result.agentRun.stopReason).toBe("completed");
    expect(result.agentRun.depth).toBe(1);
    expect(result.agentRun.executor).toBe("claude");
    expect(result.agentRun.model).toBe("claude-sonnet-4-6");
    expect(result.agentRun.promptVersion).toBe("1");
    expect(result.agentRun.turns).toBe(0);
    expect(result.agentRun.inputTokens).toBe(0);
    expect(result.agentRun.outputTokens).toBe(0);
    expect(result.agentRun.cacheCreationTokens).toBe(0);
    expect(result.agentRun.cacheReadTokens).toBe(0);
    expect(result.agentRun.costUsd).toBe(0);
    expect(result.agentRun.sessionId).toMatch(/^stub-implementer-/);
    expect(result.agentRun.startedAt).toBeDefined();
    expect(result.agentRun.completedAt).toBeDefined();
  });

  it("write-file mode creates, commits, and returns the HEAD sha", async () => {
    // Minimal git repo with an identity so `git commit` works in isolation.
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "stub@example.com"], {
      cwd: worktree,
    });
    await execFileAsync("git", ["config", "user.name", "Stub"], {
      cwd: worktree,
    });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "init", "-q"], {
      cwd: worktree,
    });

    const runner = createStubImplementerRunner({
      writeFile: { relativePath: "NOTES.md", contents: "hi" },
    });
    const result = await runner.run({
      task: buildTask({ slug: "notes" }),
      worktreePath: worktree,
      baseSha: "deadbeef",
      systemPrompt: "sp",
      promptVersion: "1",
      model: "claude-sonnet-4-6",
    });

    expect(result.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const written = await readFile(path.join(worktree, "NOTES.md"), "utf8");
    expect(written).toBe("hi");

    const { stdout } = await execFileAsync(
      "git",
      ["log", "-1", "--pretty=%s"],
      { cwd: worktree },
    );
    expect(stdout.trim()).toBe("feat(notes): stub implementer placeholder");
  });

  it("rejects writeFile paths that escape the worktree", async () => {
    const runner = createStubImplementerRunner({
      writeFile: { relativePath: "../escape.txt", contents: "boom" },
    });
    await expect(
      runner.run({
        task: buildTask(),
        worktreePath: worktree,
        baseSha: "deadbeef",
        systemPrompt: "sp",
        promptVersion: "1",
        model: "claude-sonnet-4-6",
      }),
    ).rejects.toThrow(/escapes worktreePath/);
  });

  it("writeFileBySlug picks the per-slug path; falls back to writeFile otherwise", async () => {
    // Seed a real git repo so the commit path can run end-to-end.
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "stub@example.com"], {
      cwd: worktree,
    });
    await execFileAsync("git", ["config", "user.name", "Stub"], {
      cwd: worktree,
    });
    await execFileAsync(
      "git",
      ["commit", "--allow-empty", "-m", "init", "-q"],
      { cwd: worktree },
    );

    const runner = createStubImplementerRunner({
      writeFileBySlug: {
        bySlug: {
          "p5-task-a": "phase5-smoke/task-a.txt",
          "p5-task-b": "phase5-smoke/task-b.txt",
        },
        contents: "stub body",
      },
      writeFile: { relativePath: "FALLBACK.md", contents: "fallback body" },
    });

    // Task with a matching slug → uses bySlug path.
    const matched = await runner.run({
      task: buildTask({ slug: "p5-task-a" }),
      worktreePath: worktree,
      baseSha: "deadbeef",
      systemPrompt: "sp",
      promptVersion: "1",
      model: "claude-sonnet-4-6",
    });
    expect(matched.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const wroteA = await readFile(
      path.join(worktree, "phase5-smoke/task-a.txt"),
      "utf8",
    );
    expect(wroteA).toBe("stub body");

    // Task whose slug is not in the map → falls back to writeFile.
    const unmatched = await runner.run({
      task: buildTask({ slug: "some-other-slug" }),
      worktreePath: worktree,
      baseSha: "deadbeef",
      systemPrompt: "sp",
      promptVersion: "1",
      model: "claude-sonnet-4-6",
    });
    expect(unmatched.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const wroteFallback = await readFile(
      path.join(worktree, "FALLBACK.md"),
      "utf8",
    );
    expect(wroteFallback).toBe("fallback body");
  });
});
