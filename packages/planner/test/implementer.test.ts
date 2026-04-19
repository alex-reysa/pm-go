import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Task } from "@pm-go/contracts";
import {
  createStubImplementerRunner,
  type ImplementerRunner,
  type ImplementerRunnerInput,
  type ImplementerRunnerResult,
} from "@pm-go/executor-claude";

import { runImplementer } from "../src/implementer.js";

const execFileAsync = promisify(execFile);

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    planId: "6d1f4c3a-5f2b-4e27-9d8c-9a7f1b2c3d4e",
    phaseId: "11111111-2222-4333-8444-555555555555",
    slug: "run-implementer-task",
    title: "Run implementer task",
    summary: "Task used to exercise runImplementer in unit tests.",
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

async function initGitWorktree(cwd: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd });
  await execFileAsync(
    "git",
    ["commit", "--allow-empty", "-m", "init", "-q"],
    { cwd },
  );
}

describe("runImplementer", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), "pm-go-runimpl-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  it("invokes the stub runner, loads the implementer prompt, and returns a 40-hex commit sha", async () => {
    await initGitWorktree(worktree);
    const runner = createStubImplementerRunner({
      writeFile: { relativePath: "NOTES.md", contents: "hi" },
    });

    const result = await runImplementer({
      task: buildTask({ slug: "notes" }),
      worktreePath: worktree,
      baseSha: "deadbeef",
      requestedBy: "alex@example.com",
      runner,
    });

    expect(result.agentRun.role).toBe("implementer");
    expect(result.agentRun.status).toBe("completed");
    expect(result.agentRun.model).toBe("claude-sonnet-4-6");
    expect(result.agentRun.promptVersion).toBe("implementer@1");
    expect(result.finalCommitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("applies default model/budget/turns when caller omits them", async () => {
    const captured: { input?: ImplementerRunnerInput } = {};
    const spy: ImplementerRunner = {
      run: async (input): Promise<ImplementerRunnerResult> => {
        captured.input = input;
        // Sanity-check that runImplementer loaded the on-disk prompt.
        expect(input.systemPrompt).toContain("pm-go implementer");
        expect(input.promptVersion).toBe("implementer@1");
        return {
          agentRun: {
            id: "00000000-0000-4000-8000-000000000001",
            workflowRunId: "spy-workflow-run",
            role: "implementer",
            depth: 1,
            status: "completed",
            riskLevel: "low",
            executor: "claude",
            model: input.model,
            promptVersion: input.promptVersion,
            permissionMode: "default",
            startedAt: "2026-04-18T00:00:00.000Z",
            completedAt: "2026-04-18T00:00:01.000Z",
          },
        };
      },
    };

    await runImplementer({
      task: buildTask(),
      worktreePath: worktree,
      baseSha: "deadbeef",
      requestedBy: "alex@example.com",
      runner: spy,
    });

    expect(captured.input).toBeDefined();
    expect(captured.input!.model).toBe("claude-sonnet-4-6");
    expect(captured.input!.budgetUsdCap).toBe(2.0);
    expect(captured.input!.maxTurnsCap).toBe(60);
    expect(captured.input!.worktreePath).toBe(worktree);
    expect(captured.input!.baseSha).toBe("deadbeef");
  });

  it("forwards caller-provided model/budget/turns unchanged", async () => {
    const captured: { input?: ImplementerRunnerInput } = {};
    const spy: ImplementerRunner = {
      run: async (input): Promise<ImplementerRunnerResult> => {
        captured.input = input;
        return {
          agentRun: {
            id: "00000000-0000-4000-8000-000000000002",
            workflowRunId: "spy-workflow-run",
            role: "implementer",
            depth: 1,
            status: "completed",
            riskLevel: "low",
            executor: "claude",
            model: input.model,
            promptVersion: input.promptVersion,
            permissionMode: "default",
            startedAt: "2026-04-18T00:00:00.000Z",
            completedAt: "2026-04-18T00:00:01.000Z",
          },
        };
      },
    };

    await runImplementer({
      task: buildTask(),
      worktreePath: worktree,
      baseSha: "deadbeef",
      requestedBy: "alex@example.com",
      runner: spy,
      model: "claude-haiku-4-5",
      budgetUsdCap: 0.5,
      maxTurnsCap: 10,
    });

    expect(captured.input!.model).toBe("claude-haiku-4-5");
    expect(captured.input!.budgetUsdCap).toBe(0.5);
    expect(captured.input!.maxTurnsCap).toBe(10);
  });
});
