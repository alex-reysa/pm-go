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

function makeMockDb(rowsPerSelect: unknown[][] = []) {
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
  const values = vi.fn().mockResolvedValue([]);
  const insert = vi.fn().mockImplementation(() => ({ values }));
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockImplementation(() => ({ where }));
  const update = vi.fn().mockImplementation(() => ({ set }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { select, insert, update } as any, select, insert, values, update, set, where };
}

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const PLAN_ID = "22222222-3333-4444-8555-666666666666";
const RUN_ID = "33333333-4444-4555-8666-777777777777";
const TOOL_CALL_ID = "44444444-5555-4666-8777-888888888888";

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    taskId: TASK_ID,
    planId: PLAN_ID,
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

describe("GET /agent-runs?planId=&role=", () => {
  it("returns orchestrator runs for a plan", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [
        makeRun({
          id: RUN_ID,
          taskId: null,
          role: "orchestrator",
          depth: 0,
          promptVersion: "orchestrator@1",
        }),
      ],
    ]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(
      `/agent-runs?planId=${PLAN_ID}&role=orchestrator`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      agentRuns: Array<{ id: string; role: string; planId?: string }>;
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.agentRuns).toEqual([
      expect.objectContaining({
        id: RUN_ID,
        role: "orchestrator",
        planId: PLAN_ID,
      }),
    ]);
  });

  it("returns 400 when planId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const { db } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/agent-runs?planId=nope&role=orchestrator");
    expect(res.status).toBe(400);
  });
});

describe("POST/PATCH /agent-runs", () => {
  it("creates an orchestrator agent run with planId and numeric fields", async () => {
    const { client } = makeMockTemporal();
    const { db, insert, values } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request("/agent-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: RUN_ID,
        planId: PLAN_ID,
        workflowRunId: "wf-orchestrator",
        role: "orchestrator",
        depth: 0,
        status: "running",
        riskLevel: "low",
        executor: "claude",
        model: "claude-sonnet-4-6",
        promptVersion: "orchestrator@1",
        permissionMode: "plan",
        budgetUsdCap: "2.50",
        startedAt: "2026-04-19T10:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: RUN_ID,
        planId: PLAN_ID,
        role: "orchestrator",
        budgetUsdCap: 2.5,
      }),
    );
    const body = (await res.json()) as {
      agentRun: { id: string; role: string; budgetUsdCap?: number };
    };
    expect(body.agentRun).toEqual(
      expect.objectContaining({
        id: RUN_ID,
        role: "orchestrator",
        budgetUsdCap: 2.5,
      }),
    );
  });

  it("patches an agent run status and cost fields", async () => {
    const { client } = makeMockTemporal();
    const { db, update, set, where } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs/${RUN_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        turns: "6",
        costUsd: "0.123456",
        completedAt: "2026-04-19T10:01:00.000Z",
        stopReason: "completed",
      }),
    });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        turns: 6,
        costUsd: 0.123456,
      }),
    );
    expect(where).toHaveBeenCalledTimes(1);
  });
});

function makeToolCall(overrides: Record<string, unknown> = {}) {
  return {
    id: TOOL_CALL_ID,
    agentRunId: RUN_ID,
    sequence: 1,
    toolName: "db.query",
    sanitizedInput: { table: "plans" },
    summarizedOutput: { rows: 1 },
    status: "completed",
    startedAt: "2026-04-19T10:00:00.000Z",
    completedAt: "2026-04-19T10:00:01.000Z",
    errorReason: null,
    specDocumentId: null,
    repoSnapshotId: null,
    planId: PLAN_ID,
    phaseId: null,
    taskId: null,
    ...overrides,
  };
}

describe("GET/POST/PATCH /agent-runs/:runId/tool-calls", () => {
  it("lists tool calls for an agent run", async () => {
    const { client } = makeMockTemporal();
    const { db } = makeMockDb([[makeToolCall()]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs/${RUN_ID}/tool-calls`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentRunId: string;
      toolCalls: Array<{ id: string; toolName: string; planId?: string }>;
    };
    expect(body.agentRunId).toBe(RUN_ID);
    expect(body.toolCalls).toEqual([
      expect.objectContaining({
        id: TOOL_CALL_ID,
        toolName: "db.query",
        planId: PLAN_ID,
      }),
    ]);
  });

  it("creates a tool call under an agent run", async () => {
    const { client } = makeMockTemporal();
    const { db, insert, values } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs/${RUN_ID}/tool-calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: TOOL_CALL_ID,
        sequence: 1,
        toolName: "plan.read",
        sanitizedInput: { planId: PLAN_ID },
        status: "running",
        startedAt: "2026-04-19T10:00:00.000Z",
        planId: PLAN_ID,
      }),
    });
    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TOOL_CALL_ID,
        agentRunId: RUN_ID,
        toolName: "plan.read",
        sanitizedInput: { planId: PLAN_ID },
        status: "running",
      }),
    );
  });

  it("patches a tool call completion", async () => {
    const { client } = makeMockTemporal();
    const { db, update, set, where } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(
      `/agent-runs/${RUN_ID}/tool-calls/${TOOL_CALL_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          summarizedOutput: { ok: true },
          completedAt: "2026-04-19T10:00:01.000Z",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "completed",
        summarizedOutput: { ok: true },
      }),
    );
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("rejects non-object sanitizedInput", async () => {
    const { client } = makeMockTemporal();
    const { db } = makeMockDb();
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/agent-runs/${RUN_ID}/tool-calls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "bad",
        sanitizedInput: [],
        status: "running",
      }),
    });
    expect(res.status).toBe(400);
  });
});
