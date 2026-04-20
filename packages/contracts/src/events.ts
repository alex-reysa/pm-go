import type { PhaseStatus, TaskStatus, UUID } from "./plan.js";
import type { Artifact } from "./execution.js";

/**
 * Phase 6 workflow-event stream — a read-model projection of the
 * Phase 5 durable state transitions. Events are additive and
 * append-only; they do NOT drive the control plane. The `plans`,
 * `phases`, `plan_tasks`, `merge_runs`, `phase_audit_reports`,
 * `completion_audit_reports`, and `artifacts` tables remain
 * authoritative.
 *
 * Union grows additively: each emit point the worker wires in adds
 * a new variant + kind literal. Consumers exhaustive-switch on
 * `kind` so a new variant is a compile error until explicitly
 * handled — the tradeoff is better than stringly-typed payloads.
 */
export type WorkflowEventKind =
  | "phase_status_changed"
  | "task_status_changed"
  | "artifact_persisted";

/**
 * Shared shape for every `WorkflowEvent`. `planId` is always
 * present so a plan-scoped replay can filter with a single column.
 * `phaseId` / `taskId` / other subject ids live on the concrete
 * variants, not here — not every event kind has the same subject
 * shape, and pushing them down keeps each variant self-documenting.
 */
export interface WorkflowEventBase {
  id: UUID;
  planId: UUID;
  kind: WorkflowEventKind;
  /** ISO-8601 timestamp. Primary sort key for replay + SSE tail. */
  createdAt: string;
}

/**
 * Emitted whenever a `phases.status` column transitions. Covers the
 * full phase state machine (pending → planning → executing →
 * integrating → auditing → completed | blocked | failed). The
 * payload carries before/after so a UI can render the transition
 * without re-reading the phase row.
 */
export interface PhaseStatusChangedEvent extends WorkflowEventBase {
  kind: "phase_status_changed";
  phaseId: UUID;
  payload: {
    previousStatus: PhaseStatus;
    nextStatus: PhaseStatus;
  };
}

/**
 * Emitted whenever a `plan_tasks.status` column transitions. Mirrors
 * the phase-status shape so dashboard code can fold both into the
 * same timeline component.
 */
export interface TaskStatusChangedEvent extends WorkflowEventBase {
  kind: "task_status_changed";
  taskId: UUID;
  /**
   * Phase the task belongs to. Denormalized onto the event so a
   * phase-scoped UI can render task transitions without a join —
   * the `phases` column on the row captures this for the same
   * reason.
   */
  phaseId: UUID;
  payload: {
    previousStatus: TaskStatus;
    nextStatus: TaskStatus;
  };
}

/**
 * Emitted when a new row lands in `artifacts`. Today that's the
 * PR summary + evidence bundle from `FinalReleaseWorkflow`; future
 * commits may add review-report or test-report artifacts. The event
 * stream lets the release UI react without polling the artifacts
 * table.
 */
export interface ArtifactPersistedEvent extends WorkflowEventBase {
  kind: "artifact_persisted";
  payload: {
    artifactId: UUID;
    artifactKind: Artifact["kind"];
    /**
     * `file://` URI for local artifacts today. Clients should go
     * through `GET /artifacts/:id` to fetch content — the URI is
     * here for debugging/audit, not direct fetch.
     */
    uri: string;
  };
}

/**
 * Discriminated union of every Phase 6 workflow event. Extend by
 * adding a new variant and widening `WorkflowEventKind`.
 */
export type WorkflowEvent =
  | PhaseStatusChangedEvent
  | TaskStatusChangedEvent
  | ArtifactPersistedEvent;
