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
    firstExecutionRunId: "run-events-xyz",
    workflowId: "wf-events-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

/**
 * Minimal drizzle select mock: `.select(...).from(...).where(...).limit(N)`
 * and `.select(...).from(...).where(...).orderBy(...)` both resolve to the
 * next rowset from `rowsPerSelect`.
 */
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

const PLAN_ID = "11111111-2222-4333-8444-555555555555";
const PHASE_ID = "22222222-3333-4444-8555-666666666666";
const EVENT_ID_1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EVENT_ID_2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function makeEventRow(id: string, createdAt: string) {
  return {
    id,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    taskId: null,
    kind: "phase_status_changed",
    payload: { previousStatus: "executing", nextStatus: "integrating" },
    createdAt,
  };
}

describe("GET /events", () => {
  it("returns 400 when planId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });
    const res = await app.request("/events?planId=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns 400 when planId is missing", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });
    const res = await app.request("/events");
    expect(res.status).toBe(400);
  });

  it("returns the plan's event stream ordered by createdAt with lastEventId echoed", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeEventRow(EVENT_ID_1, "2026-04-19T10:00:00.000Z"),
      makeEventRow(EVENT_ID_2, "2026-04-19T10:00:05.000Z"),
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });

    const res = await app.request(`/events?planId=${PLAN_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      events: Array<{ id: string; kind: string; phaseId: string }>;
      lastEventId: string | null;
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]!.id).toBe(EVENT_ID_1);
    expect(body.events[1]!.id).toBe(EVENT_ID_2);
    expect(body.lastEventId).toBe(EVENT_ID_2);
  });

  it("returns lastEventId=null when the plan has no events yet", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      lastEventId: string | null;
    };
    expect(body.events).toEqual([]);
    expect(body.lastEventId).toBeNull();
  });

  it("returns 400 when sinceEventId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });
    const res = await app.request(
      `/events?planId=${PLAN_ID}&sinceEventId=not-a-uuid`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when sinceEventId points to an event that doesn't exist", async () => {
    const { client } = makeMockTemporal();
    // First select (the cursor lookup) returns empty → 404.
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(
      `/events?planId=${PLAN_ID}&sinceEventId=${EVENT_ID_1}`,
    );
    expect(res.status).toBe(404);
  });

  it("drops rows whose phaseId is null for phase_status_changed (kind/subject mismatch protection)", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeEventRow(EVENT_ID_1, "2026-04-19T10:00:00.000Z"),
      // Malformed row — kind says phase_status_changed but phaseId is null.
      {
        ...makeEventRow(EVENT_ID_2, "2026-04-19T10:00:05.000Z"),
        phaseId: null,
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });

    const res = await app.request(`/events?planId=${PLAN_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ id: string }>;
      lastEventId: string | null;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.id).toBe(EVENT_ID_1);
    expect(body.lastEventId).toBe(EVENT_ID_1);
  });

  it("maps task_status_changed rows with taskId+phaseId subject", async () => {
    const { client } = makeMockTemporal();
    const taskId = "cccccccc-dddd-4eee-8fff-000000000000";
    const rows = [
      {
        id: EVENT_ID_1,
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        taskId,
        kind: "task_status_changed",
        payload: { previousStatus: "in_review", nextStatus: "ready_to_merge" },
        createdAt: "2026-04-19T10:10:00.000Z",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{
        id: string;
        kind: string;
        taskId?: string;
        phaseId?: string;
      }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.kind).toBe("task_status_changed");
    expect(body.events[0]!.taskId).toBe(taskId);
    expect(body.events[0]!.phaseId).toBe(PHASE_ID);
  });

  it("drops task_status_changed rows that lack taskId or phaseId", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      {
        id: EVENT_ID_1,
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        taskId: null, // malformed — task_status_changed must have taskId
        kind: "task_status_changed",
        payload: { previousStatus: "pending", nextStatus: "running" },
        createdAt: "2026-04-19T10:00:00.000Z",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("maps artifact_persisted rows (plan-scoped; no phase/task subject)", async () => {
    const { client } = makeMockTemporal();
    const artifactId = "eeeeeeee-ffff-4000-8111-222222222222";
    const rows = [
      {
        id: EVENT_ID_1,
        planId: PLAN_ID,
        phaseId: null,
        taskId: null,
        kind: "artifact_persisted",
        payload: {
          artifactId,
          artifactKind: "pr_summary",
          uri: "file:///tmp/artifacts/x.md",
        },
        createdAt: "2026-04-19T11:00:00.000Z",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    const body = (await res.json()) as {
      events: Array<{
        id: string;
        kind: string;
        payload: { artifactId: string; artifactKind: string };
      }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.kind).toBe("artifact_persisted");
    expect(body.events[0]!.payload.artifactId).toBe(artifactId);
    expect(body.events[0]!.payload.artifactKind).toBe("pr_summary");
  });

  it("drops rows with unknown kinds instead of crashing (partial-rollout safety)", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeEventRow(EVENT_ID_1, "2026-04-19T10:00:00.000Z"),
      {
        id: EVENT_ID_2,
        planId: PLAN_ID,
        phaseId: PHASE_ID,
        taskId: null,
        kind: "some_future_kind_we_dont_know",
        payload: {},
        createdAt: "2026-04-19T10:00:05.000Z",
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    const body = (await res.json()) as {
      events: Array<{ id: string }>;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.id).toBe(EVENT_ID_1);
  });
});
