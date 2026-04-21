import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { phases } from "./phases.js";
import { planTasks } from "./plan-tasks.js";
import { plans } from "./plans.js";

/**
 * Phase 6 `workflow_events` — append-only read-model projection of
 * Phase 5 state transitions. Drives the operator UI's SSE stream and
 * list views; NOT authoritative for any phase/task/merge/audit state.
 *
 * First-commit scope carries a single `kind` literal
 * (`phase_status_changed`). Future commits add `task_status_changed`,
 * `merge_run_started`, `merge_run_completed`, `phase_audit_outcome`,
 * `completion_audit_outcome`, and `artifact_persisted` here. The
 * pgEnum gets extended via ALTER TYPE … ADD VALUE migrations — cheap
 * and backward-compatible for consumers that already parse the union.
 *
 * `payload` carries kind-specific fields (e.g. previousStatus /
 * nextStatus for phase_status_changed). The TypeBox validator in
 * `@pm-go/contracts` is the source of truth for shape; the DB just
 * stores JSONB.
 */
export const workflowEventKind = pgEnum("workflow_event_kind", [
  "phase_status_changed",
  "task_status_changed",
  "artifact_persisted",
  // Phase 7: span emitted by `@pm-go/observability`'s `withSpan` wrapper.
  // `trace_id` / `span_id` below carry the correlation keys; `payload`
  // carries the `Span` contract shape. Added via migration 0012 with
  // ALTER TYPE … ADD VALUE — cheap and backward-compatible.
  "span_emitted",
]);

export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    // Optional subject ids. Not every kind has a phase or task. The
    // contract validator enforces per-kind required-ness; the DB
    // leaves them nullable so future kinds (plan-scoped release events,
    // etc.) don't need a schema change.
    phaseId: uuid("phase_id").references(() => phases.id, {
      onDelete: "cascade",
    }),
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "cascade",
    }),
    kind: workflowEventKind("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    // Phase 7 trace correlation. Nullable because legacy rows predate
    // the column and because not every future event kind will carry a
    // span (e.g. operator-initiated approvals arrive without an OTel
    // context). `trace_id` is indexed for plan-agnostic trace replay.
    traceId: text("trace_id"),
    spanId: text("span_id"),
  },
  (table) => ({
    // Plan-scoped chronological replay is the primary access pattern
    // (SSE replay + operator dashboard). A single composite index
    // serves both "events for plan X" and "events for plan X since
    // timestamp T" without a second index.
    planCreatedIdx: index("workflow_events_plan_created_idx").on(
      table.planId,
      table.createdAt,
    ),
    // Secondary index for phase-scoped queries (drill-down in the UI).
    phaseIdx: index("workflow_events_phase_idx").on(table.phaseId),
    // Phase 7: trace-scoped lookup (e.g. "show me every event in trace
    // X" across plans). Non-unique — a trace fans out over many rows.
    traceIdx: index("workflow_events_trace_idx").on(table.traceId),
  }),
);

export type WorkflowEventsRow = typeof workflowEvents.$inferSelect;
export type WorkflowEventsInsert = typeof workflowEvents.$inferInsert;

/** Exposed for reference — future migrations extend this enum. */
export const WORKFLOW_EVENT_KINDS = [
  "phase_status_changed",
  "task_status_changed",
  "artifact_persisted",
  "span_emitted",
] as const;
