import { randomUUID } from "node:crypto";

import type { UUID, WorkflowEvent } from "@pm-go/contracts";
import { workflowEvents, type PmGoDb } from "@pm-go/db";

/**
 * Phase 6 workflow-event emission activity. Consumed by the
 * integration/audit/completion activity layers to project durable
 * state transitions into the `workflow_events` read model.
 *
 * Emission is best-effort: if the insert fails, we log and continue.
 * The `workflow_events` table is a projection, never the source of
 * truth, so a lost event must never block a phase transition or
 * audit pass.
 */

export interface EventActivityDeps {
  db: PmGoDb;
}

export function createEventActivities(deps: EventActivityDeps) {
  const { db } = deps;

  return {
    /**
     * Persist a single `WorkflowEvent`. Caller supplies everything
     * except `id` + `createdAt` so the activity stays pure with
     * respect to the event-kind union (no per-kind branching here).
     *
     * Best-effort: swallow + log any DB error so a failed emit
     * can't block the workflow step that invoked it. The
     * `workflow_events` table is a read model — callers shouldn't
     * have to care about its health.
     */
    async emitWorkflowEvent(
      input: Omit<WorkflowEvent, "id" | "createdAt"> &
        Partial<Pick<WorkflowEvent, "id" | "createdAt">>,
    ): Promise<{ eventId: UUID | null }> {
      const id: UUID = input.id ?? randomUUID();
      const createdAt: string = input.createdAt ?? new Date().toISOString();
      try {
        await db.insert(workflowEvents).values({
          id,
          planId: input.planId,
          // Subject ids: runtime-narrowed from the discriminated union.
          // Only the phaseId carrier is emitted today; task/other
          // subject ids live on future variants and get added here
          // when those variants land.
          phaseId:
            input.kind === "phase_status_changed" ? input.phaseId : null,
          taskId: null,
          kind: input.kind,
          payload: input.payload,
          createdAt,
        });
        return { eventId: id };
      } catch (err) {
        // Best-effort: surface once in the worker log, never rethrow.
        // The projection missing an event is strictly less bad than a
        // phase transition rolling back because a read-model insert
        // blew up.
        console.warn(
          `[events] emit failed (kind=${input.kind} planId=${input.planId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { eventId: null };
      }
    },
  };
}
