import { sql } from "drizzle-orm";
import {
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { planTasks } from "./plan-tasks.js";
import { plans } from "./plans.js";

export const artifactKind = pgEnum("artifact_kind", [
  "plan_markdown",
  "review_report",
  "completion_audit_report",
  "completion_evidence_bundle",
  "test_report",
  "event_log",
  "patch_bundle",
  "pr_summary",
  // v0.8.2.1 P1.4 — sanitized payload + schema-validation summary
  // captured when a Claude runner's structured_output fails runtime
  // schema validation. JSON content lives under
  // <artifactDir>/runner-diagnostics/<artifactId>.json.
  "runner_diagnostic",
]);

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "cascade",
    }),
    planId: uuid("plan_id").references(() => plans.id, {
      onDelete: "cascade",
    }),
    kind: artifactKind("kind").notNull(),
    uri: text("uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    taskOrPlan: check(
      "artifacts_task_or_plan_present",
      sql`(${table.taskId} IS NOT NULL) OR (${table.planId} IS NOT NULL)`,
    ),
  }),
);

export type ArtifactsRow = typeof artifacts.$inferSelect;
export type ArtifactsInsert = typeof artifacts.$inferInsert;
