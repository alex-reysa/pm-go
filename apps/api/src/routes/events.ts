import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { and, asc, eq, gt } from "drizzle-orm";

import type { UUID, WorkflowEvent } from "@pm-go/contracts";
import { workflowEvents, type PmGoDb } from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

/**
 * Phase 6 events route. Replay-only in this first commit; SSE live-
 * tail lands in a follow-up. The shape is designed so SSE can layer
 * on top without changing the replay contract:
 *
 *   GET /events?planId=<uuid>                  — full chronological
 *                                                replay for the plan
 *   GET /events?planId=<uuid>&sinceEventId=<uuid>
 *                                              — replay entries after
 *                                                the named cursor
 *
 * Events are ordered by (createdAt, id) ascending so SSE clients can
 * resume from the last seen event id without missing concurrent
 * inserts that share a millisecond.
 */
export interface EventsRouteDeps {
  db: PmGoDb;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

type WorkflowEventRow = typeof workflowEvents.$inferSelect;

/**
 * Row → contract mapper. Applies the kind-specific subject id shape
 * the TypeBox validator expects (each variant has its own required
 * subject ids). Any row whose subject ids don't match its kind is
 * dropped — the contract is authoritative, the DB is just storage.
 *
 * Payload is cast, not re-validated: the insert path writes typed
 * payloads from the worker activity layer; the DB enum + the
 * emitting activity's typed input are the validation front. The
 * `/events` read path could reject on mismatch via
 * `validateWorkflowEvent`, but that doubles the cost per row and
 * surfaces no new guarantee in the current single-writer setup.
 */
function rowToEvent(row: WorkflowEventRow): WorkflowEvent | null {
  switch (row.kind) {
    case "phase_status_changed": {
      if (row.phaseId === null) return null;
      return {
        id: row.id,
        planId: row.planId,
        phaseId: row.phaseId,
        kind: "phase_status_changed",
        payload: row.payload as Extract<
          WorkflowEvent,
          { kind: "phase_status_changed" }
        >["payload"],
        createdAt: toIso(row.createdAt),
      };
    }
    case "task_status_changed": {
      if (row.taskId === null || row.phaseId === null) return null;
      return {
        id: row.id,
        planId: row.planId,
        taskId: row.taskId,
        phaseId: row.phaseId,
        kind: "task_status_changed",
        payload: row.payload as Extract<
          WorkflowEvent,
          { kind: "task_status_changed" }
        >["payload"],
        createdAt: toIso(row.createdAt),
      };
    }
    case "artifact_persisted": {
      return {
        id: row.id,
        planId: row.planId,
        kind: "artifact_persisted",
        payload: row.payload as Extract<
          WorkflowEvent,
          { kind: "artifact_persisted" }
        >["payload"],
        createdAt: toIso(row.createdAt),
      };
    }
    default:
      // Unknown kind — future variants land here. Drop rather than
      // crash the replay so a partially-rolled-out deploy (new worker
      // emitting a kind the API doesn't know yet) doesn't poison the
      // stream.
      return null;
  }
}

/**
 * Shared replay helper — fetches the plan's events since an optional
 * cursor. Returns the mapped `WorkflowEvent[]` plus the resolved
 * createdAt of the cursor (null when no cursor was provided). Used
 * by both the JSON replay path and the SSE tail's bootstrap phase.
 */
async function fetchEventsSince(
  db: PmGoDb,
  planId: UUID,
  sinceCreatedAt: string | null,
): Promise<WorkflowEvent[]> {
  const rows = await db
    .select()
    .from(workflowEvents)
    .where(
      sinceCreatedAt === null
        ? eq(workflowEvents.planId, planId)
        : and(
            eq(workflowEvents.planId, planId),
            gt(workflowEvents.createdAt, sinceCreatedAt),
          ),
    )
    .orderBy(asc(workflowEvents.createdAt), asc(workflowEvents.id));

  const events: WorkflowEvent[] = [];
  for (const row of rows) {
    const ev = rowToEvent(row);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Resolve the `sinceEventId` cursor to its DB `createdAt` timestamp.
 * Returns `null` when the caller didn't pass a cursor, an error
 * response when the cursor is malformed or the row is missing.
 */
async function resolveCursor(
  db: PmGoDb,
  sinceEventId: string | undefined,
):
  | Promise<
      | { ok: true; createdAt: string | null }
      | { ok: false; status: 400 | 404; body: { error: string } }
    > {
  if (sinceEventId === undefined) return { ok: true, createdAt: null };
  if (!isUuid(sinceEventId)) {
    return {
      ok: false,
      status: 400,
      body: { error: "sinceEventId query param must be a UUID when present" },
    };
  }
  const [cursor] = await db
    .select({ createdAt: workflowEvents.createdAt })
    .from(workflowEvents)
    .where(eq(workflowEvents.id, sinceEventId))
    .limit(1);
  if (!cursor) {
    return {
      ok: false,
      status: 404,
      body: { error: `sinceEventId ${sinceEventId} not found` },
    };
  }
  return { ok: true, createdAt: toIso(cursor.createdAt) };
}

/** Poll interval for SSE live-tail. Short enough that an operator
 * sees phase transitions quickly; long enough that idle plans don't
 * hammer Postgres. */
const SSE_POLL_INTERVAL_MS = 1500;

/** Heartbeat interval — keeps proxies (nginx default 60s) from
 * closing idle connections. Sent as an SSE comment line. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export function createEventsRoute(deps: EventsRouteDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const planId = c.req.query("planId");
    const sinceEventId = c.req.query("sinceEventId");

    if (!isUuid(planId)) {
      return c.json({ error: "planId query param must be a UUID" }, 400);
    }

    const cursor = await resolveCursor(deps.db, sinceEventId);
    if (!cursor.ok) {
      return c.json(cursor.body, cursor.status);
    }

    // Content-negotiate on Accept. A browser EventSource sends
    // `text/event-stream`; everything else falls through to the JSON
    // replay shape the dashboard's initial fetch uses.
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return streamSSE(c, async (stream) => {
        await runSseLoop(stream, c.req.raw.signal, deps.db, planId, cursor.createdAt);
      });
    }

    const events = await fetchEventsSince(deps.db, planId, cursor.createdAt);
    return c.json(
      {
        planId,
        events,
        // Echoed so the client can stitch subsequent requests without
        // re-reading the response body to find the last id.
        lastEventId:
          events.length > 0 ? events[events.length - 1]!.id : null,
      },
      200,
    );
  });

  return app;
}

/**
 * SSE loop: replay → poll → heartbeat. Exits when the client
 * aborts the connection (signal fires) or the stream closes (Hono's
 * runtime signals shutdown). Each emit is wrapped in try/catch so a
 * partial socket close during `writeSSE` doesn't poison the loop —
 * the next iteration observes `stream.closed` / the abort signal
 * and exits cleanly.
 */
async function runSseLoop(
  stream: SSEStreamingApi,
  signal: AbortSignal,
  db: PmGoDb,
  planId: UUID,
  initialCursorCreatedAt: string | null,
): Promise<void> {
  let lastCreatedAt = initialCursorCreatedAt;

  // Emit a retry hint once up front: on disconnect the browser
  // EventSource will reconnect after this many ms (Chrome defaults
  // to ~3s; we override to 2s so operator dashboards recover fast).
  try {
    await stream.writeSSE({ event: "ready", data: "ok", retry: 2000 });
  } catch {
    return;
  }

  // Replay phase. Emit every existing event that matches the cursor.
  const initial = await fetchEventsSince(db, planId, lastCreatedAt);
  for (const ev of initial) {
    if (signal.aborted || stream.closed) return;
    try {
      await stream.writeSSE({
        id: ev.id,
        event: ev.kind,
        data: JSON.stringify(ev),
      });
      lastCreatedAt = ev.createdAt;
    } catch {
      return;
    }
  }

  // Poll phase. Interleave DB polls with heartbeat comments so
  // idle connections survive proxy timeouts.
  let lastHeartbeat = Date.now();
  while (!signal.aborted && !stream.closed) {
    await sleep(SSE_POLL_INTERVAL_MS, signal);
    if (signal.aborted || stream.closed) break;

    let tailed: WorkflowEvent[];
    try {
      tailed = await fetchEventsSince(db, planId, lastCreatedAt);
    } catch (err) {
      // DB hiccup — emit as an `error` event and continue. The
      // stream stays open; the next tick retries.
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({
            message: err instanceof Error ? err.message : String(err),
          }),
        });
      } catch {
        return;
      }
      continue;
    }

    if (tailed.length > 0) {
      for (const ev of tailed) {
        if (signal.aborted || stream.closed) return;
        try {
          await stream.writeSSE({
            id: ev.id,
            event: ev.kind,
            data: JSON.stringify(ev),
          });
          lastCreatedAt = ev.createdAt;
        } catch {
          return;
        }
      }
      lastHeartbeat = Date.now();
      continue;
    }

    // No new events this tick. Fire a heartbeat if the last emit
    // is old enough. Heartbeat is an SSE comment (`:` prefix) so
    // clients ignore it but proxies count it as traffic.
    if (Date.now() - lastHeartbeat >= SSE_HEARTBEAT_INTERVAL_MS) {
      try {
        await stream.write(": heartbeat\n\n");
        lastHeartbeat = Date.now();
      } catch {
        return;
      }
    }
  }
}

/**
 * Abort-aware sleep: resolves after `ms` OR when the signal aborts,
 * whichever comes first. Lets the poll loop exit promptly on
 * disconnect instead of waiting for the next tick.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      cleanup();
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
