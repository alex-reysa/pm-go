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

/**
 * Caller shape — the full `WorkflowEvent` discriminated union
 * minus the host-controlled `id` + `createdAt` fields (both
 * optional; defaults are generated here). Union preservation
 * matters: callers TypeScript-narrow on `kind` and the activity
 * internally switches on the same discriminant.
 */
export type EmitWorkflowEventInput = WorkflowEvent extends infer E
  ? E extends { id: UUID; createdAt: string }
    ? Omit<E, "id" | "createdAt"> &
        Partial<Pick<E, "id" | "createdAt">>
    : never
  : never;

export function createEventActivities(deps: EventActivityDeps) {
  const { db } = deps;

  return {
    /**
     * Persist a single `WorkflowEvent`. The caller supplies the
     * variant-specific fields (`phaseId`, `taskId`, `payload`);
     * `id` + `createdAt` default when omitted.
     *
     * The per-kind switch is load-bearing: each variant carries
     * different subject ids, and the DB row needs the right
     * `phaseId` / `taskId` columns set regardless of whether the
     * caller spelled them on the input.
     */
    async emitWorkflowEvent(
      input: EmitWorkflowEventInput,
    ): Promise<{ eventId: UUID | null }> {
      const id: UUID = input.id ?? randomUUID();
      const createdAt: string = input.createdAt ?? new Date().toISOString();

      // Extract subject-id columns per variant. Kept as an explicit
      // switch so a new variant is a compile error here until
      // handled — the DB projection must mirror the contract.
      let phaseId: UUID | null = null;
      let taskId: UUID | null = null;
      switch (input.kind) {
        case "phase_status_changed":
          phaseId = input.phaseId;
          break;
        case "task_status_changed":
          taskId = input.taskId;
          phaseId = input.phaseId;
          break;
        case "artifact_persisted":
          // Plan-scoped; no phase or task subject.
          break;
      }

      try {
        await db.insert(workflowEvents).values({
          id,
          planId: input.planId,
          phaseId,
          taskId,
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
