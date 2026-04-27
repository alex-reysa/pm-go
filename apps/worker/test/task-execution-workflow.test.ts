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

let uuid4Counter = 0;
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => `00000000-0000-4000-8000-${String(++uuid4Counter).padStart(12, "0")}`,
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

  describe("small-task fast path", () => {
    function smallTask(): Task {
      return {
        ...taskFixture,
        sizeHint: "small",
        riskLevel: "low",
        requiresHumanApproval: false,
        reviewerPolicy: {
          ...taskFixture.reviewerPolicy,
          required: false,
        },
      };
    }

    it("transitions a clean small task directly to ready_to_merge with a policy_decisions audit row", async () => {
      const task = smallTask();
      const lease = makeLease();
      const agentRun = makeAgentRun();
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(lease);
      activityFns.runImplementer.mockResolvedValue({
        agentRun,
        finalCommitSha: "abc1234567890",
      });
      activityFns.persistAgentRun.mockResolvedValue(agentRun.id);
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/y.ts"],
        violations: [],
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);

      expect(result.status).toBe("ready_to_merge");
      expect(result.reviewSkippedPolicyDecisionId).toBeDefined();
      expect(activityFns.persistPolicyDecision).toHaveBeenCalledTimes(1);
      const decisionArg = activityFns.persistPolicyDecision.mock.calls[0]![0];
      expect(decisionArg).toMatchObject({
        subjectType: "task",
        subjectId: task.id,
        decision: "approved",
        actor: "system",
      });
      expect(decisionArg.reason).toContain("review_skipped_small_task:");

      // Ends in ready_to_merge, NOT ready_for_review.
      const statuses = activityFns.updateTaskStatus.mock.calls.map(
        (c) => (c[0] as { status: string }).status,
      );
      expect(statuses).toEqual(["running", "ready_to_merge"]);
    });

    it("falls back to ready_for_review when the task is small but riskLevel='high'", async () => {
      const task: Task = { ...smallTask(), riskLevel: "high" };
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/y.ts"],
        violations: [],
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_for_review");
      expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
    });

    it("falls back to ready_for_review when reviewerPolicy.required=true (medium task)", async () => {
      const task: Task = {
        ...smallTask(),
        sizeHint: "medium",
        reviewerPolicy: {
          ...taskFixture.reviewerPolicy,
          required: true,
        },
      };
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/y.ts"],
        violations: [],
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_for_review");
      expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
    });

    it("falls back to ready_for_review when requiresHumanApproval=true", async () => {
      const task: Task = { ...smallTask(), requiresHumanApproval: true };
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/y.ts"],
        violations: [],
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_for_review");
      expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
    });

    it("falls back to ready_for_review when changed file count exceeds the fast-path host limit", async () => {
      const task = smallTask();
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      // 7 files > the 6-file host limit.
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: [
          "packages/x/src/a.ts",
          "packages/x/src/b.ts",
          "packages/x/src/c.ts",
          "packages/x/src/d.ts",
          "packages/x/src/e.ts",
          "packages/x/src/f.ts",
          "packages/x/src/g.ts",
        ],
        violations: [],
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_for_review");
      expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
    });

    it("falls back to ready_for_review when linesChanged exceeds the fast-path host limit (v0.8.2.1 P2.1)", async () => {
      const task = smallTask();
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      // One file but 200 changed lines — file count alone would let
      // this through; the line-count guard refuses.
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/big.ts"],
        violations: [],
        linesChanged: 200,
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_for_review");
      expect(activityFns.persistPolicyDecision).not.toHaveBeenCalled();
    });

    it("takes the fast path when linesChanged is well within the limit", async () => {
      const task = smallTask();
      activityFns.loadTask.mockResolvedValue(task);
      activityFns.updateTaskStatus.mockResolvedValue(undefined);
      activityFns.leaseWorktree.mockResolvedValue(makeLease());
      activityFns.runImplementer.mockResolvedValue({
        agentRun: makeAgentRun(),
        finalCommitSha: "abc",
      });
      activityFns.persistAgentRun.mockResolvedValue("ar");
      activityFns.diffWorktreeAgainstScope.mockResolvedValue({
        changedFiles: ["packages/x/src/small.ts"],
        violations: [],
        linesChanged: 12,
      });

      const result = await TaskExecutionWorkflow(BASE_INPUT);
      expect(result.status).toBe("ready_to_merge");
      expect(activityFns.persistPolicyDecision).toHaveBeenCalledTimes(1);
    });
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

// ---------------------------------------------------------------------------
// v0.8.6 P0 hygiene-guard tests for the activity itself.
//
// The workflow tests above mock `commitAgentWork` end-to-end. These tests
// exercise the real activity with a stubbed `checkIgnore` and a stubbed
// `exec` so we can prove the guard's two branches:
//   1. check-ignore returns paths      → typed failure, no commit, task
//                                          blocked, paths persisted on the
//                                          agent run.
//   2. check-ignore returns empty list → existing happy path runs unchanged
//                                          (stage + commit + return sha).
// ---------------------------------------------------------------------------
const {
  createTaskExecutionActivities,
  IGNORED_ARTIFACT_COMMITTED,
} = await import("../src/activities/task-execution.js");

interface FakeDb {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  // Tracks every set() payload for later assertions.
  updateCalls: Array<{ table: string; set: Record<string, unknown> }>;
}

/**
 * Build a tiny drizzle-shaped mock that returns the supplied rows for
 * the selects the activity issues (worktree_leases lookup, then
 * agent_runs lookup). `update` and `insert` are no-ops that record
 * their arguments for assertion.
 */
function makeFakeDb(rows: {
  leaseRows: Array<{ taskId: string | null }>;
  agentRunRows: Array<{ id: string }>;
  // For updateTaskStatus() if it ends up being called; defaults to one
  // row with status `running`.
  prevTaskRows?: Array<{ status: string; planId: string; phaseId: string }>;
}): FakeDb {
  const updateCalls: Array<{ table: string; set: Record<string, unknown> }> =
    [];
  let selectCount = 0;
  // commitAgentWork issues exactly two selects in the rejection branch:
  // (1) worktree_leases by worktreePath, (2) agent_runs by taskId.
  // updateTaskStatus would issue a third (plan_tasks by id) — supplied
  // for completeness even though the activity-level test path never
  // calls updateTaskStatus directly.
  const selectQueue: Array<unknown[]> = [
    rows.leaseRows,
    rows.agentRunRows,
    rows.prevTaskRows ?? [
      { status: "running", planId: "plan-1", phaseId: "phase-1" },
    ],
  ];
  const select = vi.fn().mockImplementation(() => {
    const next = selectQueue[selectCount++] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(next);
    return chain;
  });
  const update = vi.fn().mockImplementation((table: { _: { name?: string } }) => {
    const tableName =
      (table as unknown as { [s: symbol]: { name?: string } })?.[
        Symbol.for("drizzle:Name")
      ]?.name ??
      // Drizzle stores the table name on a few different internal
      // symbols across versions. Fall back to a stringification.
      String((table as { _name?: string })._name ?? "unknown");
    return {
      set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
        updateCalls.push({ table: tableName, set: payload });
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    };
  });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ select, update, insert }),
  );
  return {
    select,
    update,
    insert,
    transaction,
    updateCalls,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("commitAgentWork hygiene guard (v0.8.6 P0)", () => {
  const taskId = "11111111-2222-4333-8444-555555555555";
  const agentRunId = "22222222-3333-4444-8555-666666666666";
  const worktreePath = "/tmp/worktrees/stub";

  it("rejects when check-ignore returns ignored paths and persists them on the agent run", async () => {
    const checkIgnore = vi.fn().mockResolvedValue([
      "node_modules/foo",
      "node_modules/bar/baz.js",
    ]);
    const exec = vi
      .fn()
      // listPendingPaths uses `git status --porcelain`. We return one
      // `?? <path>` entry so check-ignore has something to filter; the
      // exact contents don't matter because the guard delegates to the
      // stubbed checkIgnore.
      .mockResolvedValueOnce({ stdout: "?? node_modules/foo\n", stderr: "" });
    const db = makeFakeDb({
      leaseRows: [{ taskId }],
      agentRunRows: [{ id: agentRunId }],
    });

    const acts = createTaskExecutionActivities({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      implementerRunner: {
        run: async () => {
          throw new Error("not used in this test");
        },
      },
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
      checkIgnore,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: exec as any,
    });

    const result = await acts.commitAgentWork({
      worktreePath,
      taskSlug: "demo",
      commitTitle: "feat(demo): demo",
    });

    // 1. Typed failure surfaces back to the caller.
    expect(result).toEqual({
      ok: false,
      reason: IGNORED_ARTIFACT_COMMITTED,
      paths: ["node_modules/foo", "node_modules/bar/baz.js"],
    });

    // 2. No staging or committing happened — exec was only called once,
    //    for `git status --porcelain`. `git add`, `git commit`, and
    //    `git rev-parse` were NOT invoked.
    expect(exec).toHaveBeenCalledTimes(1);
    const argv = exec.mock.calls[0]?.[1] as string[];
    expect(argv[0]).toBe("status");

    // 3. Offending paths land on the agent run record. The guard joins
    //    the paths into the errorReason text prefixed by the symbol.
    const agentRunUpdate = db.updateCalls.find((c) =>
      typeof c.set.errorReason === "string",
    );
    expect(agentRunUpdate?.set.errorReason).toContain(
      IGNORED_ARTIFACT_COMMITTED,
    );
    expect(agentRunUpdate?.set.errorReason).toContain("node_modules/foo");
    expect(agentRunUpdate?.set.errorReason).toContain(
      "node_modules/bar/baz.js",
    );

    // 4. Task transitions to `blocked`.
    const blockedUpdate = db.updateCalls.find(
      (c) => c.set.status === "blocked",
    );
    expect(blockedUpdate, "expected a plan_tasks update with status=blocked").toBeDefined();
  });

  it("preserves stub-runtime e2e behavior when check-ignore returns empty", async () => {
    const checkIgnore = vi.fn().mockResolvedValue([]);
    // exec receives all of `git status`, `git add`, `git commit`, and
    // `git rev-parse` calls in order. Resolve the stdout each one
    // expects so the activity reaches the sha-return branch.
    const exec = vi.fn().mockImplementation(async (...args: unknown[]) => {
      const argv = args[1] as string[];
      // git status --porcelain v1 format: "XY <path>" — two status chars
      // and a separator before the path. Use the canonical " M " (space
      // + M + space) for an unstaged modification.
      if (argv[0] === "status") return { stdout: " M packages/x/y.ts\n", stderr: "" };
      if (argv[0] === "add") return { stdout: "", stderr: "" };
      if (argv[0] === "commit") return { stdout: "[main abc] commit", stderr: "" };
      if (argv[0] === "rev-parse") return { stdout: "abc1234\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const db = makeFakeDb({
      leaseRows: [],
      agentRunRows: [],
    });

    const acts = createTaskExecutionActivities({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      implementerRunner: {
        run: async () => {
          throw new Error("not used in this test");
        },
      },
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
      checkIgnore,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: exec as any,
    });

    const result = await acts.commitAgentWork({
      worktreePath,
      taskSlug: "demo",
      commitTitle: "feat(demo): demo",
    });

    // Happy path: typed success with the resolved sha. No update calls
    // touched plan_tasks or agent_runs because the guard short-circuited
    // *before* attempting any persistence.
    expect(result).toEqual({ ok: true, sha: "abc1234" });

    // checkIgnore saw the porcelain-derived path; assert it was actually
    // invoked with the candidate path so the contract is exercised.
    expect(checkIgnore).toHaveBeenCalledWith(
      worktreePath,
      ["packages/x/y.ts"],
    );

    // No DB persistence on the happy path.
    expect(db.updateCalls).toEqual([]);
  });

  it("skips the check-ignore subprocess entirely when the worktree has no pending changes", async () => {
    const checkIgnore = vi.fn().mockResolvedValue([]);
    const exec = vi.fn().mockImplementation(async (...args: unknown[]) => {
      const argv = args[1] as string[];
      // Empty status output → no pending paths → guard short-circuits
      // and falls through to the legacy stage/commit path. The
      // subsequent commit attempt fails with "nothing to commit" which
      // we expect the activity to translate to `{ ok: true }` (no sha).
      if (argv[0] === "status") return { stdout: "", stderr: "" };
      if (argv[0] === "add") return { stdout: "", stderr: "" };
      if (argv[0] === "commit") {
        const err = Object.assign(new Error("nothing to commit"), {
          stdout: "nothing to commit, working tree clean",
          stderr: "",
        });
        throw err;
      }
      return { stdout: "", stderr: "" };
    });
    const db = makeFakeDb({ leaseRows: [], agentRunRows: [] });

    const acts = createTaskExecutionActivities({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      implementerRunner: {
        run: async () => {
          throw new Error("not used in this test");
        },
      },
      repoRoot: "/tmp/repo",
      worktreeRoot: "/tmp/worktrees",
      checkIgnore,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: exec as any,
    });

    const result = await acts.commitAgentWork({
      worktreePath,
      taskSlug: "demo",
      commitTitle: "feat(demo): demo",
    });

    expect(result).toEqual({ ok: true });
    expect(checkIgnore).not.toHaveBeenCalled();
  });
});

