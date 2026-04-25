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
 * Task status literal set. Mirrors `TaskStatus` in `plan.ts` —
 * colocated like `PhaseStatusLiteralSchema` for the same reason
 * (keep the events lane free of cross-lane imports).
 */
export const TaskStatusLiteralSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("in_review"),
  Type.Literal("fixing"),
  Type.Literal("ready_to_merge"),
  Type.Literal("merged"),
  Type.Literal("blocked"),
  Type.Literal("failed"),
]);

/**
 * Artifact kind literal set. Mirrors `Artifact['kind']` in
 * `execution.ts`. Must stay in lockstep with `artifactKind` pgEnum
 * in `packages/db/src/schema/artifacts.ts`.
 */
export const ArtifactKindLiteralSchema = Type.Union([
  Type.Literal("plan_markdown"),
  Type.Literal("review_report"),
  Type.Literal("completion_audit_report"),
  Type.Literal("completion_evidence_bundle"),
  Type.Literal("test_report"),
  Type.Literal("event_log"),
  Type.Literal("patch_bundle"),
  Type.Literal("pr_summary"),
  Type.Literal("runner_diagnostic"),
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
 * TypeBox schema for `TaskStatusChangedEvent`. Emitted when
 * `plan_tasks.status` transitions. `phaseId` is denormalized for
 * phase-scoped UI filters.
 */
export const TaskStatusChangedEventSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    taskId: UuidSchema,
    phaseId: UuidSchema,
    kind: Type.Literal("task_status_changed"),
    payload: Type.Object(
      {
        previousStatus: TaskStatusLiteralSchema,
        nextStatus: TaskStatusLiteralSchema,
      },
      { additionalProperties: false },
    ),
    createdAt: Iso8601Schema,
  },
  { $id: "TaskStatusChangedEvent", additionalProperties: false },
);

/**
 * TypeBox schema for `ArtifactPersistedEvent`. Emitted on insert
 * into `artifacts`. The payload carries the artifact id, kind, and
 * file:// URI; clients fetch content via `GET /artifacts/:id`.
 */
export const ArtifactPersistedEventSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    kind: Type.Literal("artifact_persisted"),
    payload: Type.Object(
      {
        artifactId: UuidSchema,
        artifactKind: ArtifactKindLiteralSchema,
        uri: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    createdAt: Iso8601Schema,
  },
  { $id: "ArtifactPersistedEvent", additionalProperties: false },
);

/**
 * Union of every known `WorkflowEvent` variant. Validation
 * discriminates on `kind` so a malformed variant fails against its
 * specific member rather than falling through to an unknown-kind
 * error. Add new emit points by appending here + widening the
 * hand-written `WorkflowEvent` interface.
 */
export const WorkflowEventSchema = Type.Union(
  [
    PhaseStatusChangedEventSchema,
    TaskStatusChangedEventSchema,
    ArtifactPersistedEventSchema,
  ],
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
