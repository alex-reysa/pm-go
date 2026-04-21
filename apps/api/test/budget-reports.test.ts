import { describe, it, expect, vi } from "vitest";

import { createApp } from "../src/app.js";

/**
 * Phase 7 — `GET /plans/:planId/budget-report` aggregates every
 * `agent_runs` row joined to `plan_tasks` for the plan, sums cost +
 * tokens + wall clock, and returns the BudgetReport contract shape.
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
 * Drizzle stub: `.select(...).from(...).innerJoin(...).where(...).orderBy(...)`
 * resolves to the `rows` argument; `.insert(...).values(...)` resolves
 * to a no-op.
 */
function makeMockDb(rows: unknown[]) {
  const select = vi.fn().mockImplementation(() => {
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
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select, insert } as any;
}

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const TASK_A = "22222222-2222-4222-8222-222222222222";
const TASK_B = "33333333-3333-4333-8333-333333333333";

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

describe("GET /plans/:planId/budget-report", () => {
  it("400s when planId is not a UUID", async () => {
    const db = makeMockDb([]);
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/plans/not-a-uuid/budget-report`);

    expect(res.status).toBe(400);
  });

  it("returns an empty report when no agent_runs rows exist", async () => {
    const db = makeMockDb([]);
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/plans/${PLAN_ID}/budget-report`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      totalUsd: number;
      totalTokens: number;
      totalWallClockMinutes: number;
      perTaskBreakdown: unknown[];
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.totalUsd).toBe(0);
    expect(body.totalTokens).toBe(0);
    expect(body.totalWallClockMinutes).toBe(0);
    expect(body.perTaskBreakdown).toHaveLength(0);
  });

  it("aggregates cost + tokens + wallClockMinutes across runs and per task", async () => {
    const rows = [
      {
        taskId: TASK_A,
        costUsd: "0.10",
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 0,
        cacheReadTokens: 25,
        // 2 minutes
        startedAt: "2026-04-19T10:00:00.000Z",
        completedAt: "2026-04-19T10:02:00.000Z",
      },
      {
        taskId: TASK_A,
        costUsd: "0.05",
        inputTokens: 200,
        outputTokens: 75,
        cacheCreationTokens: 10,
        cacheReadTokens: 0,
        // 1 minute
        startedAt: "2026-04-19T10:03:00.000Z",
        completedAt: "2026-04-19T10:04:00.000Z",
      },
      {
        taskId: TASK_B,
        costUsd: "0.20",
        inputTokens: 300,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 50,
        // 3 minutes
        startedAt: "2026-04-19T10:05:00.000Z",
        completedAt: "2026-04-19T10:08:00.000Z",
      },
    ];
    const db = makeMockDb(rows);
    const app = createApp({ temporal: makeMockTemporal(), db, ...APP_DEFAULTS });

    const res = await app.request(`/plans/${PLAN_ID}/budget-report`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      totalUsd: number;
      totalTokens: number;
      totalWallClockMinutes: number;
      perTaskBreakdown: Array<{
        taskId: string;
        totalUsd: number;
        totalTokens: number;
        totalWallClockMinutes: number;
      }>;
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.totalUsd).toBeCloseTo(0.35, 6);
    // 100+50+0+25 + 200+75+10+0 + 300+100+0+50 = 175+285+450 = 910
    expect(body.totalTokens).toBe(910);
    expect(body.totalWallClockMinutes).toBeCloseTo(6, 3);
    expect(body.perTaskBreakdown).toHaveLength(2);
    const a = body.perTaskBreakdown.find((b) => b.taskId === TASK_A);
    const b = body.perTaskBreakdown.find((b) => b.taskId === TASK_B);
    expect(a?.totalUsd).toBeCloseTo(0.15, 6);
    // Task A: 175 + 285 = 460
    expect(a?.totalTokens).toBe(460);
    expect(a?.totalWallClockMinutes).toBeCloseTo(3, 3);
    expect(b?.totalUsd).toBeCloseTo(0.2, 6);
    expect(b?.totalTokens).toBe(450);
    expect(b?.totalWallClockMinutes).toBeCloseTo(3, 3);
  });
});
