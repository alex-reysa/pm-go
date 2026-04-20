import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { WorkflowEvent } from "../../events.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

// Side-effect: register `uuid` + `date-time` format validators with
// TypeBox's global FormatRegistry. The orchestration-review lane
// already imports this module; re-import here so the events lane is
// self-sufficient if used in isolation.
import "../orchestration-review/formats.js";

/**
 * Phase-status literal set. Mirrors `PhaseStatus` in `plan.ts` —
 * colocated here rather than re-imported via a typebox wrapper because
 * the events lane avoids a dependency on the orchestration-review
 * lane's sub-schemas.
 */
export const PhaseStatusLiteralSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("planning"),
  Type.Literal("executing"),
  Type.Literal("integrating"),
  Type.Literal("auditing"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);

/**
 * TypeBox schema for `PhaseStatusChangedEvent`. Emitted whenever a
 * `phases.status` transition is observed by the worker activity
 * layer. The payload captures before + after so SSE clients can
 * render without rereading the phases table.
 */
export const PhaseStatusChangedEventSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    phaseId: UuidSchema,
    kind: Type.Literal("phase_status_changed"),
    payload: Type.Object(
      {
        previousStatus: PhaseStatusLiteralSchema,
        nextStatus: PhaseStatusLiteralSchema,
      },
      { additionalProperties: false },
    ),
    createdAt: Iso8601Schema,
  },
  { $id: "PhaseStatusChangedEvent", additionalProperties: false },
);

/**
 * Union of every known `WorkflowEvent` variant. Intentionally narrow
 * in this first commit — later emit points (task, merge, audit,
 * artifact) add new members here. Keeping it a `Type.Union` even
 * with a single member means validation is already discriminating
 * on `kind`, so extending it doesn't require re-plumbing callers.
 */
export const WorkflowEventSchema = Type.Union(
  [PhaseStatusChangedEventSchema],
  { $id: "WorkflowEvent" },
);

export type WorkflowEventSchemaType = Static<typeof WorkflowEventSchema>;

// Compile-time structural sanity: the TypeBox-emitted shape must be
// assignable to the hand-written `WorkflowEvent` interface. Drifts
// get caught by tsc before runtime tests even run.
type _WorkflowEventSubtypeCheck = WorkflowEventSchemaType extends WorkflowEvent
  ? true
  : never;
const _workflowEventOk: _WorkflowEventSubtypeCheck = true;
void _workflowEventOk;

/**
 * Runtime validator for `WorkflowEvent`. Narrows `unknown` to
 * `WorkflowEvent` on success; false on any shape mismatch including
 * unknown `kind`.
 */
export function validateWorkflowEvent(value: unknown): value is WorkflowEvent {
  return Value.Check(WorkflowEventSchema, value);
}
