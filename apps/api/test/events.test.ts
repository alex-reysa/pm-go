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

/**
 * Parse a text/event-stream response body into structured records.
 * Supports `id:`, `event:`, `data:`, `retry:`, and comment lines
 * (`: ...`). Each record is terminated by a blank line per the
 * spec.
 */
interface ParsedSseRecord {
  id?: string;
  event?: string;
  data?: string;
  retry?: number;
  comment?: string;
}

function parseSseBody(body: string): ParsedSseRecord[] {
  const records: ParsedSseRecord[] = [];
  const chunks = body.split(/\n\n+/);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const rec: ParsedSseRecord = {};
    const dataLines: string[] = [];
    for (const line of chunk.split(/\n/)) {
      if (line.startsWith(":")) {
        rec.comment = (rec.comment ?? "") + line.slice(1).trim();
        continue;
      }
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      // Per spec, exactly one space after the colon is OPTIONAL and
      // stripped from the value when present.
      let value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      switch (field) {
        case "id":
          rec.id = value;
          break;
        case "event":
          rec.event = value;
          break;
        case "data":
          dataLines.push(value);
          break;
        case "retry":
          rec.retry = Number.parseInt(value, 10);
          break;
      }
    }
    if (dataLines.length > 0) rec.data = dataLines.join("\n");
    if (rec.id || rec.event || rec.data || rec.comment) records.push(rec);
  }
  return records;
}

describe("GET /events — SSE live-tail", () => {
  /**
   * Hono's `app.request` returns a Response whose body is a ReadableStream.
   * For SSE we collect the body until the stream closes OR a deadline
   * fires; on deadline we abort the request so the SSE loop exits. The
   * route inserts a poll sleep between ticks, so tests abort after
   * one poll cycle to keep them fast.
   */
  async function collectSseBody(
    app: ReturnType<typeof createApp>,
    url: string,
    abortAfterMs: number,
  ): Promise<string> {
    const controller = new AbortController();
    const resPromise = app.request(url, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    const abort = setTimeout(() => controller.abort(), abortAfterMs);
    try {
      const res = await resPromise;
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const body = await res.text();
      return body;
    } finally {
      clearTimeout(abort);
    }
  }

  it("content-negotiates on Accept: text/event-stream and returns an SSE response", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const body = await collectSseBody(app, `/events?planId=${PLAN_ID}`, 100);
    const records = parseSseBody(body);
    // At minimum the `ready` handshake must land — the loop writes it
    // before hitting the first poll sleep.
    const ready = records.find((r) => r.event === "ready");
    expect(ready).toBeDefined();
    expect(ready!.retry).toBe(2000);
  });

  it("replays existing events as SSE messages keyed by event id", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      makeEventRow(EVENT_ID_1, "2026-04-19T10:00:00.000Z"),
      makeEventRow(EVENT_ID_2, "2026-04-19T10:00:05.000Z"),
    ];
    // Two selects hit: cursor not requested → fetchEventsSince once
    // for initial replay, then once per poll tick. Repeat the rows
    // only on the initial replay; poll returns nothing.
    const db = makeMockDbForLookup([rows, [], [], []]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const body = await collectSseBody(app, `/events?planId=${PLAN_ID}`, 300);
    const records = parseSseBody(body);
    const messages = records.filter((r) => r.event === "phase_status_changed");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.id).toBe(EVENT_ID_1);
    expect(messages[1]!.id).toBe(EVENT_ID_2);
    const parsed = JSON.parse(messages[0]!.data!) as { id: string; kind: string };
    expect(parsed.id).toBe(EVENT_ID_1);
    expect(parsed.kind).toBe("phase_status_changed");
  });

  it("returns the JSON replay shape when Accept header is missing", async () => {
    // Sanity: the SSE branch is gated exclusively on Accept. A
    // client that forgets the header must still get the JSON
    // array, not an SSE stream that never terminates.
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[makeEventRow(EVENT_ID_1, "2026-04-19T10:00:00.000Z")]]);
    const app = createApp({ temporal: client, db, ...APP_DEFAULTS });
    const res = await app.request(`/events?planId=${PLAN_ID}`);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
  });
});
