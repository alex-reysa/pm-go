import { Hono } from "hono";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function createEventsRoute(deps: EventsRouteDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const planId = c.req.query("planId");
    const sinceEventId = c.req.query("sinceEventId");

    if (!isUuid(planId)) {
      return c.json({ error: "planId query param must be a UUID" }, 400);
    }

    let sinceCreatedAt: string | null = null;
    if (sinceEventId !== undefined) {
      if (!isUuid(sinceEventId)) {
        return c.json(
          { error: "sinceEventId query param must be a UUID when present" },
          400,
        );
      }
      const [cursor] = await deps.db
        .select({ createdAt: workflowEvents.createdAt })
        .from(workflowEvents)
        .where(eq(workflowEvents.id, sinceEventId))
        .limit(1);
      if (!cursor) {
        // A missing cursor means the client has a stale id — either
        // the event was purged or never existed. Return 404 so the
        // client can either drop the cursor or surface the error.
        return c.json(
          { error: `sinceEventId ${sinceEventId} not found` },
          404,
        );
      }
      sinceCreatedAt = toIso(cursor.createdAt);
    }

    const rows = await deps.db
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
