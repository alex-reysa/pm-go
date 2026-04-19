import { describe, it, expect, vi } from "vitest";

import { createApp } from "../src/app.js";

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-task-xyz",
    workflowId: "wf-task-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

/**
 * Minimal chainable drizzle mock for the /tasks GET path:
 * `.select(...).from(...).where(...).limit(...)` and
 * `.select(...).from(...).where(...).orderBy(...).limit(...)`.
 * Each successive `.select(...)` invocation returns the next rowset in
 * `rowsPerSelect`.
 */
function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    // Self-referencing thenable: every chain method returns the same
    // object so the caller can terminate anywhere (.where, .orderBy,
    // .limit) and `await` resolves to `rows`. This matches Drizzle's
    // real query builder, which is thenable at every chainable node.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue(chain);
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

describe("POST /tasks/:taskId/run", () => {
  it("starts TaskExecutionWorkflow and returns 202 with taskId + workflowRunId", async () => {
    const { start, client } = makeMockTemporal();

    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });

    const taskId = "11111111-2222-4333-8444-555555555555";
    const res = await app.request(`/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      taskId: string;
      workflowRunId: string;
    };
    expect(payload.taskId).toBe(taskId);
    expect(payload.workflowRunId).toBe("run-task-xyz");

    expect(start).toHaveBeenCalledWith(
      "TaskExecutionWorkflow",
      expect.objectContaining({
        taskQueue: APP_DEFAULTS.taskQueue,
        workflowId: `task-exec-${taskId}`,
        args: [
          {
            taskId,
            repoRoot: APP_DEFAULTS.repoRoot,
            worktreeRoot: APP_DEFAULTS.worktreeRoot,
            maxLifetimeHours: APP_DEFAULTS.maxLifetimeHours,
            requestedBy: "api",
          },
        ],
      }),
    );
  });

  it("returns 400 when taskId is not a UUID", async () => {
    const { client } = makeMockTemporal();

    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });

    const res = await app.request(`/tasks/not-a-uuid/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /tasks/:taskId", () => {
  it("returns 404 when the task row is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);

    const app = createApp({
      temporal: client,
      db,
      ...APP_DEFAULTS,
    });

    const res = await app.request(
      `/tasks/11111111-2222-4333-8444-555555555555`,
    );
    expect(res.status).toBe(404);
  });
});

const TASK_ID = "11111111-2222-4333-8444-555555555555";

function makeTaskRow() {
  return {
    id: TASK_ID,
    planId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    phaseId: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
    slug: "demo",
    title: "demo task",
    summary: "demo",
    kind: "implementation",
    status: "in_review",
    riskLevel: "medium",
    fileScope: { includes: ["packages/x/**"], excludes: [] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 45 },
    reviewerPolicy: {
      required: true,
      strictness: "elevated",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 2,
    branchName: null,
    worktreePath: null,
  };
}

function makeReviewReportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-2222-4333-8444-555555555555",
    taskId: TASK_ID,
    reviewerRunId: "44444444-2222-4333-8444-555555555555",
    outcome: "changes_requested",
    findings: [
      {
        id: "f1",
        severity: "medium",
        title: "x",
        summary: "y",
        filePath: "x.ts",
        confidence: 0.7,
        suggestedFixDirection: "fix",
      },
    ],
    cycleNumber: 1,
    createdAt: "2026-04-19T10:00:00.000Z",
    ...overrides,
  };
}

describe("POST /tasks/:taskId/review", () => {
  it("starts TaskReviewWorkflow and returns 202 with cycleNumber", async () => {
    const { start, client } = makeMockTemporal();
    // The route runs a select for existing review_reports to compute cycle.
    const db = makeMockDbForLookup([[]]); // no prior reports → cycle 1

    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/review`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      taskId: string;
      workflowRunId: string;
      cycleNumber: number;
    };
    expect(payload.taskId).toBe(TASK_ID);
    expect(payload.cycleNumber).toBe(1);
    expect(start).toHaveBeenCalledWith(
      "TaskReviewWorkflow",
      expect.objectContaining({
        workflowId: `task-review-${TASK_ID}-1`,
        args: [{ taskId: TASK_ID }],
      }),
    );
  });

  it("returns 400 when taskId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });
    const res = await app.request(`/tasks/not-a-uuid/review`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /tasks/:taskId/fix", () => {
  it("returns 404 when the task row is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]); // empty task lookup
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/fix`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when the task is not currently in status=fixing", async () => {
    const { client, start } = makeMockTemporal();
    // Task row exists but status is `in_review` — a /fix call at this
    // point would violate the state machine.
    const db = makeMockDbForLookup([[{ status: "in_review" }]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/fix`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns 409 when no review report exists for the task", async () => {
    const { client } = makeMockTemporal();
    // Task says fixing, but the review-report lookup returns no rows —
    // inconsistent state that POST /fix should surface, not paper over.
    const db = makeMockDbForLookup([[{ status: "fixing" }], []]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/fix`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when the LATEST overall review report is not changes_requested", async () => {
    const { client, start } = makeMockTemporal();
    // The latest review report is `pass`; the route must NOT walk back
    // in time and reopen an older changes_requested cycle.
    const latestPass = makeReviewReportRow({
      outcome: "pass",
      findings: [],
      cycleNumber: 2,
      createdAt: "2026-04-19T11:00:00.000Z",
    });
    const db = makeMockDbForLookup([
      [{ status: "fixing" }],
      [latestPass],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/fix`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts TaskFixWorkflow when task=fixing AND latest report is changes_requested", async () => {
    const { start, client } = makeMockTemporal();
    const report = makeReviewReportRow(); // outcome: "changes_requested"
    const db = makeMockDbForLookup([[{ status: "fixing" }], [report]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/fix`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledWith(
      "TaskFixWorkflow",
      expect.objectContaining({
        workflowId: `task-fix-${TASK_ID}-1`,
        args: [{ taskId: TASK_ID, reviewReportId: report.id }],
      }),
    );
  });
});

describe("GET /tasks/:taskId/review-reports", () => {
  it("returns chronologically ordered reports with cycleNumber", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeReviewReportRow({
        id: "11111111-1111-4111-8111-111111111111",
        cycleNumber: 1,
        createdAt: "2026-04-19T10:00:00.000Z",
      }),
      makeReviewReportRow({
        id: "22222222-2222-4222-8222-222222222222",
        cycleNumber: 2,
        outcome: "pass",
        findings: [],
        createdAt: "2026-04-19T10:05:00.000Z",
      }),
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/review-reports`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      taskId: string;
      reports: Array<{ id: string; cycleNumber: number; outcome: string }>;
    };
    expect(payload.taskId).toBe(TASK_ID);
    expect(payload.reports).toHaveLength(2);
    expect(payload.reports[0]!.cycleNumber).toBe(1);
    expect(payload.reports[1]!.outcome).toBe("pass");
  });
});

describe("GET /tasks/:taskId includes latestReviewReport", () => {
  it("surfaces the most recent review report in the GET /tasks/:id response", async () => {
    const { client } = makeMockTemporal();
    // Four selects in order: task row, agent_run row, lease row, latest review report
    const taskRow = makeTaskRow();
    const db = makeMockDbForLookup([
      [taskRow],
      [],
      [],
      [makeReviewReportRow({ outcome: "pass", findings: [] })],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      task: { id: string };
      latestReviewReport: { outcome: string } | null;
    };
    expect(payload.task.id).toBe(TASK_ID);
    expect(payload.latestReviewReport?.outcome).toBe("pass");
  });
});
