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
  }),
);

export type WorkflowEventsRow = typeof workflowEvents.$inferSelect;
export type WorkflowEventsInsert = typeof workflowEvents.$inferInsert;

/** Exposed for reference — future migrations extend this enum. */
export const WORKFLOW_EVENT_KINDS = ["phase_status_changed"] as const;
// Reference `text` + `workflowEventKind` so tsc --noEmit keeps the
// import usable when a future commit expands the kind list.
void text;
void workflowEventKind;
