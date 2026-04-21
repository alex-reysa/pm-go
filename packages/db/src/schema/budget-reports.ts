import {
  bigint,
  index,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BudgetTaskBreakdown } from "@pm-go/contracts";

import { plans } from "./plans.js";

/**
 * Phase 7 (Worker 1) — durable plan-wide budget snapshots.
 *
 * One row per "snapshot of plan spend at a given moment". Written by
 * Worker 4's `persistBudgetReport` activity whenever a phase finishes
 * integrating or a plan completes. Read by
 * `GET /plans/:id/budget-report`.
 *
 * The `per_task_breakdown` column is a JSON array of
 * `BudgetTaskBreakdown` entries (`@pm-go/contracts`) rather than a
 * separate table because the report is immutable-once-written and is
 * always fetched whole — joining per-task costs on every read added
 * no value during Phase 6 prototyping.
 *
 * Migration: `db/migrations/0011_budget_reports.sql`.
 */
export const budgetReports = pgTable(
  "budget_reports",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    totalUsd: numeric("total_usd", { precision: 12, scale: 4 }).notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    totalWallClockMinutes: numeric("total_wall_clock_minutes", {
      precision: 10,
      scale: 2,
    }).notNull(),
    perTaskBreakdown: jsonb("per_task_breakdown")
      .$type<BudgetTaskBreakdown[]>()
      .notNull(),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    planIdIdx: index("budget_reports_plan_id_idx").on(table.planId),
  }),
);

export type BudgetReportsRow = typeof budgetReports.$inferSelect;
export type BudgetReportsInsert = typeof budgetReports.$inferInsert;
