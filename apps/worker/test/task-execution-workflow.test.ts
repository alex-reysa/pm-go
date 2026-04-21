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
  // Phase 7 — pre-flight budget gate. Default to ok:true so existing
  // happy-path assertions stay green; budget-block tests override.
  evaluateBudgetGateActivity: vi.fn(async () => ({ ok: true })),
  persistPolicyDecision: vi.fn(async () => "policy-decision-id"),
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
  // Phase 7 default: budget gate passes so the existing happy-path
  // tests stay closed over their original assertions. Tests that
  // exercise the budget-blocked branch override this in-line.
  activityFns.evaluateBudgetGateActivity.mockResolvedValue({ ok: true });
  activityFns.persistPolicyDecision.mockResolvedValue("policy-decision-id");
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

  it("stamps the task `failed` and re-throws when the implementer crashes", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.leaseWorktree.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockRejectedValue(
      new Error("implementer crashed"),
    );

    await expect(TaskExecutionWorkflow(BASE_INPUT)).rejects.toThrow(
      "implementer crashed",
    );

    // After the failure: no downstream activities run.
    expect(activityFns.persistAgentRun).not.toHaveBeenCalled();
    expect(activityFns.commitAgentWork).not.toHaveBeenCalled();
    expect(activityFns.diffWorktreeAgainstScope).not.toHaveBeenCalled();
    // Terminal status IS emitted: `running` first, then `failed` in the
    // catch branch. Without this the source of truth would be stuck at
    // `running` forever even though the workflow died.
    expect(activityFns.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(1, {
      taskId: taskFixture.id,
      status: "running",
    });
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "failed",
    });
  });

  it("still throws the original error when the failure-status update itself fails", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    // First call (running) succeeds; second call (failed) throws.
    activityFns.updateTaskStatus
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("DB down"));
    activityFns.leaseWorktree.mockRejectedValue(
      new Error("lease acquisition failed"),
    );

    // The ORIGINAL error must surface, not the secondary DB-down error.
    await expect(TaskExecutionWorkflow(BASE_INPUT)).rejects.toThrow(
      "lease acquisition failed",
    );
    // Both status-update calls were attempted.
    expect(activityFns.updateTaskStatus).toHaveBeenCalledTimes(2);
  });

  it("stamps `failed` when diff-scope itself throws", async () => {
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
    activityFns.diffWorktreeAgainstScope.mockRejectedValue(
      new Error("diff-scope crashed"),
    );

    await expect(TaskExecutionWorkflow(BASE_INPUT)).rejects.toThrow(
      "diff-scope crashed",
    );

    // Failure mid-pipeline still flips the task to `failed`, not stuck
    // in `running` (and not stamped `ready_for_review`/`blocked`).
    const calls = activityFns.updateTaskStatus.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { taskId: taskFixture.id, status: "running" },
      { taskId: taskFixture.id, status: "failed" },
    ]);
  });
});
