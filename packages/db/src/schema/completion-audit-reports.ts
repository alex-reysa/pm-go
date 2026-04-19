import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CompletionAuditSummary,
  CompletionChecklistItem,
  ReviewFinding,
} from "@pm-go/contracts";
import { agentRuns } from "./agent-runs.js";
import { mergeRuns } from "./merge-runs.js";
import { phases } from "./phases.js";
import { plans } from "./plans.js";

export const completionAuditOutcome = pgEnum("completion_audit_outcome", [
  "pass",
  "changes_requested",
  "blocked",
]);

/**
 * Phase 5 `completion_audit_reports` table — one row per
 * CompletionAuditWorkflow run. Append-only; re-audits after a
 * `changes_requested` outcome produce new rows (no uniqueness on
 * `plan_id`). The most recent row per plan is the release-readiness
 * verdict; `plans.completion_audit_report_id` tracks the latest.
 */
export const completionAuditReports = pgTable(
  "completion_audit_reports",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    finalPhaseId: uuid("final_phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "restrict" }),
    mergeRunId: uuid("merge_run_id")
      .notNull()
      .references(() => mergeRuns.id, { onDelete: "restrict" }),
    auditorRunId: uuid("auditor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    auditedHeadSha: text("audited_head_sha").notNull(),
    outcome: completionAuditOutcome("outcome").notNull(),
    checklist: jsonb("checklist")
      .$type<CompletionChecklistItem[]>()
      .notNull()
      .default([]),
    findings: jsonb("findings")
      .$type<ReviewFinding[]>()
      .notNull()
      .default([]),
    summary: jsonb("summary").$type<CompletionAuditSummary>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // "Latest completion audit per plan" is the hot-path query.
    planCreatedIdx: index("completion_audit_reports_plan_created_idx").on(
      table.planId,
      table.createdAt,
    ),
  }),
);

export type CompletionAuditReportsRow =
  typeof completionAuditReports.$inferSelect;
export type CompletionAuditReportsInsert =
  typeof completionAuditReports.$inferInsert;
