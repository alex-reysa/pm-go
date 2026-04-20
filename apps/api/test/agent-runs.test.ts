import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-agent-xyz",
    workflowId: "wf-agent-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.innerJoin = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockImplementation(() => chain);
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const TASK_ID = "11111111-2222-4333-8444-555555555555";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-run-1",
    taskId: TASK_ID,
    workflowRunId: "wf-run-1",
    role: "implementer",
    depth: 1,
    status: "completed",
    riskLevel: "low",
    model: "claude-sonnet-4-6",
    promptVersion: "implementer@1",
    permissionMode: "default",
    budgetUsdCap: "1.00",
    maxTurnsCap: 40,
    turns: 10,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: "0.012345",
    stopReason: "completed",
    startedAt: "2026-04-19T10:00:00.000Z",
    completedAt: "2026-04-19T10:00:30.000Z",
    ...overrides,
  };
}

describe("GET /agent-runs?taskId=", () => {
  it("returns 400 when taskId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/agent-runs?taskId=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns 400 when taskId is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/agent-runs");
    expect(res.status).toBe(400);
  });

  it("returns the agent-run list ordered by startedAt DESC with costUsd coerced to number", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeRun({ id: "run-newer", startedAt: "2026-04-19T12:00:00.000Z" }),
      makeRun({ id: "run-older", startedAt: "2026-04-19T10:00:00.000Z" }),
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs?taskId=${TASK_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskId: string;
      agentRuns: Array<{
        id: string;
        costUsd?: number;
      }>;
    };
    expect(body.taskId).toBe(TASK_ID);
    expect(body.agentRuns.map((r) => r.id)).toEqual(["run-newer", "run-older"]);
    // numeric columns come back from drizzle as strings; the route
    // should coerce costUsd to a proper number for JSON consumers.
    expect(typeof body.agentRuns[0]!.costUsd).toBe("number");
    expect(body.agentRuns[0]!.costUsd).toBeCloseTo(0.012345, 6);
  });

  it("returns an empty list when the task has no agent runs", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs?taskId=${TASK_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentRuns: unknown[] };
    expect(body.agentRuns).toEqual([]);
  });
});
