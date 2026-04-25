import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CompletionChecklistItem,
  ReviewFinding,
} from "@pm-go/contracts";
import { agentRuns } from "./agent-runs.js";
import { mergeRuns } from "./merge-runs.js";
import { phases } from "./phases.js";
import { plans } from "./plans.js";

export const phaseAuditOutcome = pgEnum("phase_audit_outcome", [
  "pass",
  "changes_requested",
  "blocked",
]);

/**
 * Phase 5 `phase_audit_reports` table — one row per PhaseAuditWorkflow
 * run against a specific MergeRun. Append-only; re-audits of the same
 * (phase, merge_run) pair are not permitted (unique constraint). If a
 * phase needs re-auditing, a new MergeRun must be produced first.
 */
export const phaseAuditReports = pgTable(
  "phase_audit_reports",
  {
    id: uuid("id").primaryKey(),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    mergeRunId: uuid("merge_run_id")
      .notNull()
      .references(() => mergeRuns.id, { onDelete: "restrict" }),
    auditorRunId: uuid("auditor_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "restrict" }),
    mergedHeadSha: text("merged_head_sha").notNull(),
    outcome: phaseAuditOutcome("outcome").notNull(),
    checklist: jsonb("checklist")
      .$type<CompletionChecklistItem[]>()
      .notNull()
      .default([]),
    findings: jsonb("findings")
      .$type<ReviewFinding[]>()
      .notNull()
      .default([]),
    summary: text("summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    // v0.8.2: operator override trail. Populated when an operator accepts
    // a `blocked` audit through POST /phases/:phaseId/override-audit
    // instead of issuing a direct DB update.
    overrideReason: text("override_reason"),
    overriddenBy: text("overridden_by"),
    overriddenAt: timestamp("overridden_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => ({
    // One audit per (phase, merge) — a second attempt against the same
    // merge run is a bug and should surface as a DB error, not a silent
    // overwrite.
    phaseMergeUnique: unique("phase_audit_reports_phase_merge_unique").on(
      table.phaseId,
      table.mergeRunId,
    ),
    phaseCreatedIdx: index("phase_audit_reports_phase_created_idx").on(
      table.phaseId,
      table.createdAt,
    ),
  }),
);

export type PhaseAuditReportsRow = typeof phaseAuditReports.$inferSelect;
export type PhaseAuditReportsInsert = typeof phaseAuditReports.$inferInsert;
