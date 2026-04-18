import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UUID } from "@pm-go/contracts";
import { plans } from "./plans.js";
import { repoSnapshots } from "./repo-snapshots.js";

export const phaseStatus = pgEnum("phase_status", [
  "pending",
  "planning",
  "executing",
  "integrating",
  "auditing",
  "completed",
  "blocked",
  "failed",
]);

export const phases = pgTable(
  "phases",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    status: phaseStatus("status").notNull(),
    integrationBranch: text("integration_branch").notNull(),
    baseSnapshotId: uuid("base_snapshot_id")
      .notNull()
      .references(() => repoSnapshots.id),
    taskIdsOrdered: jsonb("task_ids_ordered")
      .$type<UUID[]>()
      .notNull()
      .default([]),
    mergeOrder: jsonb("merge_order").$type<UUID[]>().notNull().default([]),
    phaseAuditReportId: uuid("phase_audit_report_id"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => ({
    planIndexUnique: uniqueIndex("phases_plan_id_index_unique").on(
      table.planId,
      table.index,
    ),
  }),
);

export type PhasesRow = typeof phases.$inferSelect;
export type PhasesInsert = typeof phases.$inferInsert;
