import type { PhaseStatus, UUID } from "./plan.js";

/**
 * Phase 6 workflow-event stream — a read-model projection of the
 * Phase 5 durable state transitions. Events are additive and
 * append-only; they do NOT drive the control plane. The `plans`,
 * `phases`, `plan_tasks`, `merge_runs`, `phase_audit_reports`,
 * `completion_audit_reports`, and `artifacts` tables remain
 * authoritative.
 *
 * The kind union is intentionally narrow in this first commit —
 * Phase 6 Worker 1 lands `phase_status_changed` as the one real
 * emit point; later commits add task/merge/audit/artifact kinds.
 * New variants extend the discriminated union; consumers should
 * exhaustive-switch on `kind`.
 */
export type WorkflowEventKind = "phase_status_changed";

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
 * Discriminated union of every Phase 6 workflow event. Extend by
 * adding a new variant and widening `WorkflowEventKind`.
 */
export type WorkflowEvent = PhaseStatusChangedEvent;
