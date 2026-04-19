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
  readWorktreeHeadSha: vi.fn(),
  countFixCyclesForTask: vi.fn(),
  loadLatestReviewReport: vi.fn(),
  runReviewer: vi.fn(),
  persistAgentRun: vi.fn(),
  persistReviewReport: vi.fn(),
  persistPolicyDecision: vi.fn(),
};

let uuidCounter = 0;
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  // Deterministic replacement for the real sandbox `uuid4` — tests just
  // need a stable string per call, not a real v4 UUID.
  uuid4: () => `mock-uuid-${++uuidCounter}`,
}));

const { TaskReviewWorkflow } = await import("../src/workflows/task-review.js");

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
    id: "11111111-2222-4333-8444-555555555555",
    taskId: taskFixture.id,
    workflowRunId: "wf-review-run-1",
    role: "auditor",
    depth: 2,
    status: "completed",
    riskLevel: taskFixture.riskLevel,
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "reviewer@1",
    permissionMode: "default",
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    stopReason: "completed",
    startedAt: "2026-04-19T10:00:00.000Z",
    completedAt: "2026-04-19T10:00:01.000Z",
  };
}

function makeFinding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    id: `f-${severity}`,
    severity,
    title: "finding",
    summary: "test",
    filePath: "x.ts",
    confidence: 0.7,
    suggestedFixDirection: "fix",
  };
}

function makeReport(
  outcome: ReviewReport["outcome"],
  findings: ReviewFinding[] = [],
): ReviewReport {
  return {
    id: "22222222-aaaa-4bbb-8ccc-000000000002",
    taskId: taskFixture.id,
    reviewerRunId: "11111111-2222-4333-8444-555555555555",
    outcome,
    findings,
    createdAt: "2026-04-19T10:00:00.000Z",
  };
}

const BASE_INPUT = { taskId: taskFixture.id };

beforeEach(() => {
  for (const fn of Object.values(activityFns)) fn.mockReset();
});

describe("TaskReviewWorkflow", () => {
  it("happy path: outcome=pass → ready_to_merge with an approved policy decision", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00dcafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(0);
    activityFns.runReviewer.mockResolvedValue({
      report: makeReport("pass"),
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("agent-run-id");
    activityFns.persistReviewReport.mockResolvedValue("report-id");
    activityFns.persistPolicyDecision.mockResolvedValue("policy-id");

    const result = await TaskReviewWorkflow(BASE_INPUT);

    // Status transitions: in_review first, then ready_to_merge.
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(1, {
      taskId: taskFixture.id,
      status: "in_review",
    });
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "ready_to_merge",
    });

    // One policy decision, approved.
    expect(activityFns.persistPolicyDecision).toHaveBeenCalledTimes(1);
    expect(activityFns.persistPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approved",
        subjectType: "review",
      }),
    );

    expect(result.report.outcome).toBe("pass");
    expect(result.taskId).toBe(taskFixture.id);
  });

  it("changes_requested within cycle cap → fixing with retry_allowed decision", async () => {
    activityFns.loadTask.mockResolvedValue({
      ...taskFixture,
      maxReviewFixCycles: 2,
    });
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(0); // cycle 1
    activityFns.runReviewer.mockResolvedValue({
      report: makeReport("changes_requested", [makeFinding("medium")]),
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.persistReviewReport.mockResolvedValue("r");
    activityFns.persistPolicyDecision.mockResolvedValue("p");

    await TaskReviewWorkflow(BASE_INPUT);

    expect(activityFns.updateTaskStatus).toHaveBeenLastCalledWith({
      taskId: taskFixture.id,
      status: "fixing",
    });
    expect(activityFns.persistPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "retry_allowed" }),
    );
  });

  it("changes_requested at cycle cap → blocked with retry_denied decision (cycle_cap)", async () => {
    activityFns.loadTask.mockResolvedValue({
      ...taskFixture,
      maxReviewFixCycles: 2,
    });
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(1); // cycle 2 = cap
    activityFns.loadLatestReviewReport.mockResolvedValue({
      ...makeReport("changes_requested", [makeFinding("medium")]),
      cycleNumber: 1,
    });
    activityFns.runReviewer.mockResolvedValue({
      report: makeReport("changes_requested", [makeFinding("medium")]),
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.persistReviewReport.mockResolvedValue("r");
    activityFns.persistPolicyDecision.mockResolvedValue("p");

    await TaskReviewWorkflow(BASE_INPUT);

    expect(activityFns.updateTaskStatus).toHaveBeenLastCalledWith({
      taskId: taskFixture.id,
      status: "blocked",
    });
    expect(activityFns.persistPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "retry_denied" }),
    );
    expect(activityFns.runReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleNumber: 2,
        previousFindings: expect.arrayContaining([
          expect.objectContaining({ id: "f-medium" }),
        ]),
      }),
    );
  });

  it("high-severity count > stopOnHighSeverityCount → blocked with rejected decision (high_severity_cap)", async () => {
    const task = {
      ...taskFixture,
      maxReviewFixCycles: 2,
      reviewerPolicy: {
        ...taskFixture.reviewerPolicy,
        stopOnHighSeverityCount: 1,
      },
    };
    activityFns.loadTask.mockResolvedValue(task);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(0); // cycle 1
    activityFns.runReviewer.mockResolvedValue({
      report: makeReport("changes_requested", [
        makeFinding("high"),
        makeFinding("high"),
        makeFinding("medium"),
      ]),
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.persistReviewReport.mockResolvedValue("r");
    activityFns.persistPolicyDecision.mockResolvedValue("p");

    await TaskReviewWorkflow(BASE_INPUT);

    expect(activityFns.updateTaskStatus).toHaveBeenLastCalledWith({
      taskId: taskFixture.id,
      status: "blocked",
    });
    expect(activityFns.persistPolicyDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "rejected" }),
    );
  });

  it("stamps `failed` and rethrows when the reviewer activity crashes", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(0);
    activityFns.runReviewer.mockRejectedValue(new Error("reviewer crashed"));

    await expect(TaskReviewWorkflow(BASE_INPUT)).rejects.toThrow(
      "reviewer crashed",
    );

    // in_review then failed.
    expect(activityFns.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "failed",
    });
    expect(activityFns.persistReviewReport).not.toHaveBeenCalled();
    expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
  });

  it("stamps `failed` when persistReviewReport throws mid-pipeline", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(makeLease());
    activityFns.readWorktreeHeadSha.mockResolvedValue("cafef00d");
    activityFns.countFixCyclesForTask.mockResolvedValue(0);
    activityFns.runReviewer.mockResolvedValue({
      report: makeReport("pass"),
      agentRun: makeAgentRun(),
    });
    activityFns.persistAgentRun.mockResolvedValue("a");
    activityFns.persistReviewReport.mockRejectedValue(new Error("DB down"));

    await expect(TaskReviewWorkflow(BASE_INPUT)).rejects.toThrow("DB down");
    const calls = activityFns.updateTaskStatus.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { taskId: taskFixture.id, status: "in_review" },
      { taskId: taskFixture.id, status: "failed" },
    ]);
  });

  it("throws cleanly when no active lease exists for the task", async () => {
    activityFns.loadTask.mockResolvedValue(taskFixture);
    activityFns.updateTaskStatus.mockResolvedValue(undefined);
    activityFns.loadLatestLease.mockResolvedValue(null);

    await expect(TaskReviewWorkflow(BASE_INPUT)).rejects.toThrow(
      /no active worktree lease/,
    );
    // Still stamps failed so the API doesn't see a stuck `in_review`.
    expect(activityFns.updateTaskStatus).toHaveBeenNthCalledWith(2, {
      taskId: taskFixture.id,
      status: "failed",
    });
  });
});
