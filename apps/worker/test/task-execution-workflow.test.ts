import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun, Task, WorktreeLease } from "@pm-go/contracts";

// The workflow module calls `proxyActivities<ActivityInterface>()` at
// module load time. Stub it to return a set of vi.fn()s we can swap in
// per-test so we can unit-test the workflow's branching without a
// Temporal test environment.
const activityFns = {
  loadTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  leaseWorktree: vi.fn(),
  runImplementer: vi.fn(),
  persistAgentRun: vi.fn(),
  commitAgentWork: vi.fn(),
  diffWorktreeAgainstScope: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
}));

// Import AFTER the mock so the module picks up our stubs.
const { TaskExecutionWorkflow } = await import(
  "../src/workflows/task-execution.js"
);

const taskFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/task.json",
    import.meta.url,
  ),
);
const taskFixture: Task = JSON.parse(readFileSync(taskFixturePath, "utf8"));

function makeLease(): WorktreeLease {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    taskId: taskFixture.id,
    repoRoot: "/tmp/repo",
    branchName: "codex/stub-branch",
    worktreePath: "/tmp/worktrees/stub",
    baseSha: "deadbeefcafe",
    expiresAt: "2026-04-19T10:00:00.000Z",
    status: "active",
  };
}

function makeAgentRun(): AgentRun {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    taskId: taskFixture.id,
    workflowRunId: "wf-task-run-1",
    role: "implementer",
    depth: 1,
    status: "completed",
    riskLevel: "medium",
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "implementer@1",
    permissionMode: "default",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    stopReason: "completed",
    startedAt: "2026-04-18T10:00:00.000Z",
    completedAt: "2026-04-18T10:00:01.000Z",
  };
}

const BASE_INPUT = {
  taskId: taskFixture.id,
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
  requestedBy: "test",
};

beforeEach(() => {
  for (const fn of Object.values(activityFns)) fn.mockReset();
});

describe("TaskExecutionWorkflow", () => {
  it("runs the happy path to ready_for_review when diff-scope finds no violations", async () => {
    const lease = makeLease();
    const agentRun = makeAgentRun();
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.leaseWorktree.mockResolvedValue(lease);
    activityFns.runImplementer.mockResolvedValue({
      agentRun,
      finalCommitSha: "abc1234567890",
    });
    activityFns.persistAgentRun.mockResolvedValue(agentRun.id);
    activityFns.diffWorktreeAgainstScope.mockResolvedValue({
      changedFiles: ["packages/executor/src/adapter.ts"],
      violations: [],
    });

    const result = await TaskExecutionWorkflow(BASE_INPUT);

    // Implementer already committed, so commitAgentWork must be skipped.
    expect(activityFns.commitAgentWork).not.toHaveBeenCalled();

    // Status transitions: running first, then ready_for_review at the end.
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(1, {
      taskId: taskFixture.id,
      status: "running",
    });
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "ready_for_review",
    });

    expect(result).toEqual({
      taskId: taskFixture.id,
      status: "ready_for_review",
      leaseId: lease.id,
      branchName: lease.branchName,
      worktreePath: lease.worktreePath,
      agentRunId: agentRun.id,
      changedFiles: ["packages/executor/src/adapter.ts"],
      fileScopeViolations: [],
    });
  });

  it("blocks the task when diff-scope reports file-scope violations", async () => {
    const lease = makeLease();
    const agentRun = makeAgentRun();
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.leaseWorktree.mockResolvedValue(lease);
    activityFns.runImplementer.mockResolvedValue({ agentRun });
    activityFns.persistAgentRun.mockResolvedValue(agentRun.id);
    // Implementer returned no commit, so the workflow invokes commitAgentWork.
    activityFns.commitAgentWork.mockResolvedValue("post-commit-sha");
    activityFns.diffWorktreeAgainstScope.mockResolvedValue({
      changedFiles: ["packages/executor/src/adapter.ts", "apps/web/src/page.tsx"],
      violations: ["apps/web/src/page.tsx"],
    });

    const result = await TaskExecutionWorkflow(BASE_INPUT);

    expect(activityFns.commitAgentWork).toHaveBeenCalledTimes(1);
    expect(activityFns.commitAgentWork).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreePath: lease.worktreePath,
        taskSlug: taskFixture.slug,
      }),
    );

    // Ends in `blocked` because of the scope violation.
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "blocked",
    });

    expect(result.status).toBe("blocked");
    expect(result.fileScopeViolations).toEqual(["apps/web/src/page.tsx"]);
    expect(result.changedFiles).toEqual([
      "packages/executor/src/adapter.ts",
      "apps/web/src/page.tsx",
    ]);
    expect(result.agentRunId).toBe(agentRun.id);
  });

  it("propagates implementer failures without advancing to diff-scope", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.leaseWorktree.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockRejectedValue(
      new Error("implementer crashed"),
    );

    await expect(TaskExecutionWorkflow(BASE_INPUT)).rejects.toThrow(
      "implementer crashed",
    );

    // After the failure, neither persistAgentRun nor diff-scope run, and
    // no terminal status transition happens.
    expect(activityFns.persistAgentRun).not.toHaveBeenCalled();
    expect(activityFns.commitAgentWork).not.toHaveBeenCalled();
    expect(activityFns.diffWorktreeAgainstScope).not.toHaveBeenCalled();
    // Only the first "running" transition has been emitted at this point.
    expect(activityFns.updateTaskStatus).toHaveBeenCalledTimes(1);
    expect(activityFns.updateTaskStatus).toHaveBeenCalledWith({
      taskId: taskFixture.id,
      status: "running",
    });
  });
});
