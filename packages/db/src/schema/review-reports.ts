import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ReviewFinding } from "@pm-go/contracts";
import { planTasks } from "./plan-tasks.js";
import { agentRuns } from "./agent-runs.js";

export const reviewOutcome = pgEnum("review_outcome", [
  "pass",
  "changes_requested",
  "blocked",
]);

export const reviewReports = pgTable(
  "review_reports",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => planTasks.id, { onDelete: "cascade" }),
    reviewerRunId: uuid("reviewer_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    outcome: reviewOutcome("outcome").notNull(),
    findings: jsonb("findings").$type<ReviewFinding[]>().notNull().default([]),
    cycleNumber: integer("cycle_number").notNull(),
    // Commit range the review audited. `reviewedBaseSha` is the
    // lease's base (same value for every cycle on the same lease);
    // `reviewedHeadSha` is the task branch tip at review time, which
    // moves forward after each fix cycle. Storing both lets a future
    // reader reconstruct the exact git diff any historical review
    // operated on, which the in-memory workflow state cannot.
    reviewedBaseSha: text("reviewed_base_sha").notNull(),
    reviewedHeadSha: text("reviewed_head_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Chronological lookup for "latest review for task" and history endpoints.
    taskCreatedIdx: index("review_reports_task_created_idx").on(
      table.taskId,
      table.createdAt,
    ),
    // One row per (task, cycleNumber). Append-only: cycles increment
    // monotonically; this constraint makes Temporal retries safe and catches
    // accidental double-writes.
    taskCycleUnique: unique("review_reports_task_cycle_unique").on(
      table.taskId,
      table.cycleNumber,
    ),
  }),
);

export type ReviewReportsRow = typeof reviewReports.$inferSelect;
export type ReviewReportsInsert = typeof reviewReports.$inferInsert;
