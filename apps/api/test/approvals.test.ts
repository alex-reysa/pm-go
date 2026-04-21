import { describe, it, expect, vi } from "vitest";

import { createApp } from "../src/app.js";

/**
 * Phase 7 — `GET /approvals?planId=<uuid>` lists approval rows
 * for the plan; `POST /tasks/:id/approve` and `POST /plans/:id/approve`
 * flip the latest pending row to `approved`. Each test mocks just
 * enough of Drizzle's chainable surface (.select().from().where()
 * .orderBy().limit()) to exercise one branch.
 */

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-xyz",
    workflowId: "wf-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { workflow: { start } } as any;
}

/**
 * Build a chainable drizzle stub. Each `.select(...)` call returns a
 * thenable chain whose terminal `await` resolves to the next `selects[i]`
 * row-set. `.update(...)` is a stub that records calls and resolves.
 * The point is to exercise the route's branching, not to validate
 * the SQL — drizzle's runtime sees the same chain shape either way.
 */
function makeMockDb(opts: {
  selects?: unknown[][];
  updateCalled?: { v: boolean };
}) {
  const selects = opts.selects ?? [];
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = selects[i++] ?? [];
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
  const update = vi.fn().mockImplementation(() => {
    if (opts.updateCalled) opts.updateCalled.v = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
    return chain;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select, update } as any;
}

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "33333333-3333-4333-8333-333333333333";

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

describe("GET /approvals", () => {
  it("400s when planId is missing", async () => {
    const db = makeMockDb({ selects: [] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/approvals`);

    expect(res.status).toBe(400);
  });

  it("400s when planId is not a UUID", async () => {
    const db = makeMockDb({ selects: [] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/approvals?planId=not-a-uuid`);

    expect(res.status).toBe(400);
  });

  it("returns approval rows ordered by requestedAt desc", async () => {
    const row = {
      id: APPROVAL_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      subject: "task",
      riskBand: "high",
      status: "pending",
      requestedBy: "policy-engine",
      approvedBy: null,
      requestedAt: new Date("2026-04-19T10:00:00Z"),
      decidedAt: null,
      reason: null,
    };
    const db = makeMockDb({ selects: [[row]] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/approvals?planId=${PLAN_ID}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      approvals: Array<{ id: string; status: string }>;
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.id).toBe(APPROVAL_ID);
    expect(body.approvals[0]!.status).toBe("pending");
  });

  it("returns an empty list when no rows exist", async () => {
    const db = makeMockDb({ selects: [[]] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/approvals?planId=${PLAN_ID}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: unknown[] };
    expect(body.approvals).toHaveLength(0);
  });
});

describe("POST /tasks/:taskId/approve", () => {
  it("400s when taskId is not a UUID", async () => {
    const db = makeMockDb({ selects: [] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/tasks/not-a-uuid/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
  });

  it("409s when no pending approval row exists", async () => {
    // First select returns [] — nothing to approve.
    const db = makeMockDb({ selects: [[]] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/tasks/${TASK_ID}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(409);
  });

  it("flips the latest pending row to approved and returns it", async () => {
    const row = {
      id: APPROVAL_ID,
      planId: PLAN_ID,
      taskId: TASK_ID,
      subject: "task",
      riskBand: "high",
      status: "pending",
      requestedBy: "policy-engine",
      approvedBy: null,
      requestedAt: new Date("2026-04-19T10:00:00Z"),
      decidedAt: null,
      reason: null,
    };
    const updatedRow = {
      ...row,
      status: "approved",
      approvedBy: "tester@example.com",
      decidedAt: new Date("2026-04-19T10:05:00Z"),
    };
    // First select picks the latest pending row; second select refetches
    // the updated row after the UPDATE.
    const updateCalled = { v: false };
    const db = makeMockDb({
      selects: [[row], [updatedRow]],
      updateCalled,
    });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/tasks/${TASK_ID}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvedBy: "tester@example.com" }),
    });

    expect(res.status).toBe(200);
    expect(updateCalled.v).toBe(true);
    const body = (await res.json()) as {
      taskId: string;
      approval: { status: string; approvedBy?: string };
    };
    expect(body.taskId).toBe(TASK_ID);
    expect(body.approval.status).toBe("approved");
    expect(body.approval.approvedBy).toBe("tester@example.com");
  });
});

describe("POST /plans/:planId/approve", () => {
  it("409s when no pending plan-scoped row exists", async () => {
    const db = makeMockDb({ selects: [[]] });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/plans/${PLAN_ID}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(409);
  });

  it("flips the latest pending plan row to approved", async () => {
    const row = {
      id: APPROVAL_ID,
      planId: PLAN_ID,
      taskId: null,
      subject: "plan",
      riskBand: "catastrophic",
      status: "pending",
      requestedBy: "policy-engine",
      approvedBy: null,
      requestedAt: new Date("2026-04-19T10:00:00Z"),
      decidedAt: null,
      reason: null,
    };
    const updatedRow = {
      ...row,
      status: "approved",
      decidedAt: new Date("2026-04-19T10:05:00Z"),
    };
    const updateCalled = { v: false };
    const db = makeMockDb({
      selects: [[row], [updatedRow]],
      updateCalled,
    });
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/plans/${PLAN_ID}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(200);
    expect(updateCalled.v).toBe(true);
    const body = (await res.json()) as {
      planId: string;
      approval: { status: string; subject: string };
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.approval.status).toBe("approved");
    expect(body.approval.subject).toBe("plan");
  });
});
