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
    // .limit, .innerJoin) and `await` resolves to `rows`. Matches the
    // shape of Drizzle's query builder, which is thenable at every
    // chainable node.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
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
  it("starts TaskExecutionWorkflow and returns 202 when owning phase is executing", async () => {
    const { start, client } = makeMockTemporal();

    const taskId = "11111111-2222-4333-8444-555555555555";
    const phaseId = "22222222-3333-4444-8555-666666666666";
    const db = makeMockDbForLookup([
      [
        {
          phaseId,
          phaseStatus: "executing",
          phaseTitle: "Phase 0",
        },
      ],
    ]);
    const app = createApp({
      temporal: client,
      db,
      ...APP_DEFAULTS,
    });

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

  it("returns 404 when the task row does not exist", async () => {
    const { client, start } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const taskId = "11111111-2222-4333-8444-555555555555";
    const res = await app.request(`/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns 409 when owning phase is pending (gate enforces sequential execution)", async () => {
    const { client, start } = makeMockTemporal();
    const taskId = "11111111-2222-4333-8444-555555555555";
    const phaseId = "22222222-3333-4444-8555-666666666666";
    const db = makeMockDbForLookup([
      [
        {
          phaseId,
          phaseStatus: "pending",
          phaseTitle: "Phase 1",
        },
      ],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      phaseId: string;
      phaseStatus: string;
    };
    expect(body.phaseStatus).toBe("pending");
    expect(body.phaseId).toBe(phaseId);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns 409 when owning phase is auditing (task already past execution)", async () => {
    const { client, start } = makeMockTemporal();
    const taskId = "11111111-2222-4333-8444-555555555555";
    const db = makeMockDbForLookup([
      [
        {
          phaseId: "22222222-3333-4444-8555-666666666666",
          phaseStatus: "auditing",
          phaseTitle: "Phase 0",
        },
      ],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(start).not.toHaveBeenCalled();
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

describe("GET /tasks (list)", () => {
  const phaseId = "22222222-3333-4444-8555-666666666666";
  const planId = "33333333-4444-4555-8666-777777777777";

  it("returns 400 when neither phaseId nor planId is provided", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/tasks");
    expect(res.status).toBe(400);
  });

  it("returns 400 when BOTH phaseId and planId are provided (exclusive)", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(
      `/tasks?phaseId=${phaseId}&planId=${planId}`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when phaseId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/tasks?phaseId=nope");
    expect(res.status).toBe(400);
  });

  it("returns the task list under the phaseId scope", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      {
        id: "t1",
        planId,
        phaseId,
        slug: "task-a",
        title: "Task A",
        status: "ready_to_merge",
        riskLevel: "low",
        kind: "foundation",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks?phaseId=${phaseId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phaseId: string;
      tasks: Array<{ id: string; slug: string }>;
    };
    expect(body.phaseId).toBe(phaseId);
    expect(body.tasks.map((t) => t.slug)).toEqual(["task-a"]);
  });

  it("returns the task list under the planId scope when phaseId is absent", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      {
        id: "t1",
        planId,
        phaseId,
        slug: "task-a",
        title: "Task A",
        status: "ready_to_merge",
        riskLevel: "low",
        kind: "foundation",
      },
      {
        id: "t2",
        planId,
        phaseId: "44444444-5555-4666-8777-888888888888",
        slug: "task-b",
        title: "Task B",
        status: "pending",
        riskLevel: "low",
        kind: "implementation",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks?planId=${planId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      tasks: Array<{ slug: string }>;
    };
    expect(body.planId).toBe(planId);
    expect(body.tasks).toHaveLength(2);
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
    sizeHint: null,
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

describe("POST /tasks/:taskId/override-review (v0.8.2 Task 2.2)", () => {
  it("400s when reason is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/override-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("404s when task is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/override-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "false positive" }),
    });
    expect(res.status).toBe(404);
  });

  it("409s when task is not in 'blocked' or 'fixing'", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: TASK_ID, status: "running", riskLevel: "medium" }],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/override-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    expect(res.status).toBe(409);
  });

  it("flips a 'blocked' task to ready_to_merge and inserts a human policy_decisions row", async () => {
    const { client } = makeMockTemporal();
    const insertCalled = { v: false };
    const updateCalled = { v: false };
    // Build a custom db that captures insert + update calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: TASK_ID,
                status: "blocked",
                riskLevel: "medium",
              },
            ]),
          }),
        }),
      })),
      insert: vi.fn().mockImplementation(() => {
        insertCalled.v = true;
        return { values: vi.fn().mockResolvedValue(undefined) };
      }),
      update: vi.fn().mockImplementation(() => {
        updateCalled.v = true;
        return {
          set: vi
            .fn()
            .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        };
      }),
    };
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}/override-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "reviewer flagged a stale fix",
        overriddenBy: "alex",
      }),
    });
    expect(res.status).toBe(200);
    expect(insertCalled.v).toBe(true);
    expect(updateCalled.v).toBe(true);
    const body = (await res.json()) as {
      newStatus: string;
      reason: string;
      overriddenBy?: string;
      policyDecisionId: string;
    };
    expect(body.newStatus).toBe("ready_to_merge");
    expect(body.reason).toContain("reviewer flagged");
    expect(body.overriddenBy).toBe("alex");
    expect(typeof body.policyDecisionId).toBe("string");
  });
});

describe("GET /tasks/:taskId surfaces small-task review-skip policy decision", () => {
  it("returns reviewSkippedDecision when a review_skipped_small_task row exists", async () => {
    const { client } = makeMockTemporal();
    const taskRow = { ...makeTaskRow(), sizeHint: "small" as const };
    const reviewSkipped = {
      id: "55555555-2222-4333-8444-555555555555",
      subjectType: "task" as const,
      subjectId: TASK_ID,
      riskLevel: "low" as const,
      decision: "approved" as const,
      reason:
        "review_skipped_small_task:sizeHint=small,changedFiles=1<=6",
      actor: "system" as const,
      createdAt: new Date("2026-04-25T10:00:00.000Z"),
    };
    const db = makeMockDbForLookup([
      [taskRow],
      [],
      [],
      [],
      [reviewSkipped],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      reviewSkippedDecision?: { reason: string; actor: string };
      taskPolicyDecisions: Array<{ reason: string }>;
    };
    expect(payload.reviewSkippedDecision?.actor).toBe("system");
    expect(payload.reviewSkippedDecision?.reason).toContain(
      "review_skipped_small_task",
    );
    expect(payload.taskPolicyDecisions).toHaveLength(1);
  });

  it("omits reviewSkippedDecision when no fast-path policy row exists", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[makeTaskRow()], [], [], [], []]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}`);
    const payload = (await res.json()) as Record<string, unknown>;
    expect("reviewSkippedDecision" in payload).toBe(false);
    expect(payload.taskPolicyDecisions).toEqual([]);
  });
});

describe("GET /tasks/:taskId round-trips sizeHint", () => {
  it("returns sizeHint='small' when the row carries it", async () => {
    const { client } = makeMockTemporal();
    const taskRow = { ...makeTaskRow(), sizeHint: "small" as const };
    const db = makeMockDbForLookup([[taskRow], [], [], []]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      task: { sizeHint?: string };
    };
    expect(payload.task.sizeHint).toBe("small");
  });

  it("omits sizeHint when the row stores NULL", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[makeTaskRow()], [], [], []]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/tasks/${TASK_ID}`);
    const payload = (await res.json()) as {
      task: Record<string, unknown>;
    };
    expect("sizeHint" in payload.task).toBe(false);
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
