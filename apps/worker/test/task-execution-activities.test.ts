import { describe, expect, it, vi } from "vitest";

import type { ImplementerRunner } from "@pm-go/executor-claude";

import { createTaskExecutionActivities } from "../src/activities/task-execution.js";

/**
 * v0.8.2.1 P1.3 regression test: the loadTask activity must hydrate
 * `sizeHint` from the DB row. Without this, the small-task fast path
 * in TaskExecutionWorkflow is unreachable in production because every
 * persisted task arrives with `sizeHint === undefined`.
 */

const TASK_ID = "11111111-2222-4333-8444-555555555555";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    planId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    phaseId: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
    slug: "demo",
    title: "demo task",
    summary: "demo",
    kind: "implementation",
    status: "pending",
    riskLevel: "low",
    sizeHint: null,
    fileScope: { includes: ["packages/x/**"], excludes: [] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 45 },
    reviewerPolicy: {
      required: false,
      strictness: "standard",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 2,
    branchName: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeMockDbReturning(row: ReturnType<typeof baseRow>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const select = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([row]),
      }),
    }),
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const stubImplementer: ImplementerRunner = {
  run: async () => {
    throw new Error("not used in this test");
  },
};

describe("loadTask activity (v0.8.2.1 P1.3)", () => {
  it("hydrates sizeHint='small' from the DB row", async () => {
    const db = makeMockDbReturning(baseRow({ sizeHint: "small" }));
    const acts = createTaskExecutionActivities({
      db,
      implementerRunner: stubImplementer,
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
    });
    const task = await acts.loadTask({ taskId: TASK_ID });
    expect(task.sizeHint).toBe("small");
  });

  it("hydrates sizeHint='medium' from the DB row", async () => {
    const db = makeMockDbReturning(baseRow({ sizeHint: "medium" }));
    const acts = createTaskExecutionActivities({
      db,
      implementerRunner: stubImplementer,
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
    });
    const task = await acts.loadTask({ taskId: TASK_ID });
    expect(task.sizeHint).toBe("medium");
  });

  it("omits sizeHint entirely when the row is NULL (legacy task)", async () => {
    const db = makeMockDbReturning(baseRow({ sizeHint: null }));
    const acts = createTaskExecutionActivities({
      db,
      implementerRunner: stubImplementer,
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
    });
    const task = await acts.loadTask({ taskId: TASK_ID });
    expect("sizeHint" in task).toBe(false);
  });
});
