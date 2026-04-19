import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRun,
  ReviewFinding,
  ReviewReport,
  Task,
  WorktreeLease,
} from "@pm-go/contracts";

const activityFns = {
  loadTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  loadLatestLease: vi.fn(),
  loadReviewReport: vi.fn(),
  runImplementer: vi.fn(),
  persistAgentRun: vi.fn(),
  commitAgentWork: vi.fn(),
  diffWorktreeAgainstScope: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
}));

const { TaskFixWorkflow } = await import("../src/workflows/task-fix.js");

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
    expiresAt: "2026-04-20T10:00:00.000Z",
    status: "active",
  };
}

function makeAgentRun(): AgentRun {
  return {
    id: "33333333-2222-4333-8444-555555555555",
    taskId: taskFixture.id,
    workflowRunId: "wf-fix-run-1",
    role: "implementer",
    depth: 1,
    status: "completed",
    riskLevel: taskFixture.riskLevel,
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
    startedAt: "2026-04-19T10:05:00.000Z",
    completedAt: "2026-04-19T10:05:30.000Z",
  };
}

function makeFinding(): ReviewFinding {
  return {
    id: "f1",
    severity: "medium",
    title: "bug",
    summary: "x",
    filePath: "src/a.ts",
    confidence: 0.8,
    suggestedFixDirection: "fix it",
  };
}

function makeStoredReport(): ReviewReport & { cycleNumber: number } {
  return {
    id: "44444444-2222-4333-8444-555555555555",
    taskId: taskFixture.id,
    reviewerRunId: "55555555-2222-4333-8444-555555555555",
    outcome: "changes_requested",
    findings: [makeFinding()],
    createdAt: "2026-04-19T10:00:00.000Z",
    cycleNumber: 1,
  };
}

const BASE_INPUT = {
  taskId: taskFixture.id,
  reviewReportId: makeStoredReport().id,
};

beforeEach(() => {
  for (const fn of Object.values(activityFns)) fn.mockReset();
});

describe("TaskFixWorkflow", () => {
  it("happy path: forwards reviewFeedback to implementer, commits if needed, flips to in_review", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.loadReviewReport.mockResolvedValue(makeStoredReport());
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockResolvedValue({
      agentRun: makeAgentRun(),
      // no finalCommitSha — workflow should run commitAgentWork.
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.commitAgentWork.mockResolvedValue("fix-commit-sha");
    activityFns.diffWorktreeAgainstScope.mockResolvedValue({
      changedFiles: ["packages/foo/src/bar.ts"],
      violations: [],
    });

    const result = await TaskFixWorkflow(BASE_INPUT);

    expect(activityFns.runImplementer).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewFeedback: expect.objectContaining({
          reportId: makeStoredReport().id,
          cycleNumber: 1,
          maxCycles: taskFixture.maxReviewFixCycles,
          findings: expect.arrayContaining([
            expect.objectContaining({ id: "f1" }),
          ]),
        }),
      }),
    );
    expect(activityFns.commitAgentWork).toHaveBeenCalledTimes(1);
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(1, {
      taskId: taskFixture.id,
      status: "running",
    });
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "in_review",
    });
    expect(result).toEqual({
      taskId: taskFixture.id,
      completed: true,
      retryReview: true,
    });
  });

  it("skips commitAgentWork when implementer produced a commit itself", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.loadReviewReport.mockResolvedValue(makeStoredReport());
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockResolvedValue({
      agentRun: makeAgentRun(),
      finalCommitSha: "implementer-commit",
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.diffWorktreeAgainstScope.mockResolvedValue({
      changedFiles: ["packages/foo/src/bar.ts"],
      violations: [],
    });

    await TaskFixWorkflow(BASE_INPUT);
    expect(activityFns.commitAgentWork).not.toHaveBeenCalled();
  });

  it("flips to blocked on fileScope violation after the fix attempt", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.loadReviewReport.mockResolvedValue(makeStoredReport());
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockResolvedValue({
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.commitAgentWork.mockResolvedValue("fix-commit-sha");
    activityFns.diffWorktreeAgainstScope.mockResolvedValue({
      changedFiles: ["packages/foo/src/bar.ts", "apps/web/src/page.tsx"],
      violations: ["apps/web/src/page.tsx"],
    });

    const result = await TaskFixWorkflow(BASE_INPUT);
    expect(activityFns.updateTaskStatus).toHaveBeenLastCalledWith({
      taskId: taskFixture.id,
      status: "blocked",
    });
    expect(result).toEqual({
      taskId: taskFixture.id,
      completed: false,
      retryReview: false,
    });
  });

  it("stamps failed when the implementer activity crashes", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.loadReviewReport.mockResolvedValue(makeStoredReport());
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.runImplementer.mockRejectedValue(new Error("implementer down"));

    await expect(TaskFixWorkflow(BASE_INPUT)).rejects.toThrow(
      "implementer down",
    );
    // running, then failed.
    const calls = activityFns.updateTaskStatus.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { taskId: taskFixture.id, status: "running" },
      { taskId: taskFixture.id, status: "failed" },
    ]);
  });

  it("rejects cleanly when the review_report id does not match the task", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.loadReviewReport.mockResolvedValue({
      ...makeStoredReport(),
      taskId: "different-task-id",
    });

    await expect(TaskFixWorkflow(BASE_INPUT)).rejects.toThrow(
      /belongs to task/,
    );
    // No status transitions happen — we error before `running`.
    expect(activityFns.updateTaskStatus).not.toHaveBeenCalled();
  });
});
