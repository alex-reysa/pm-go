import {
  type AnyPgColumn,
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Risk } from "@pm-go/contracts";
import { specDocuments } from "./spec-documents.js";
import { repoSnapshots } from "./repo-snapshots.js";
import { completionAuditReports } from "./completion-audit-reports.js";
import { specDecompositions } from "./spec-decompositions.js";

export const planStatus = pgEnum("plan_status", [
  "draft",
  "auditing",
  "approved",
  "blocked",
  "executing",
  "completed",
  "failed",
]);

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey(),
  specDocumentId: uuid("spec_document_id")
    .notNull()
    .references(() => specDocuments.id),
  repoSnapshotId: uuid("repo_snapshot_id")
    .notNull()
    .references(() => repoSnapshots.id),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: planStatus("status").notNull(),
  risks: jsonb("risks").$type<Risk[]>().notNull().default([]),
  autoApproveLowRisk: boolean("auto_approve_low_risk"),
  // Points at the most recent CompletionAuditWorkflow verdict. Updated
  // only by CompletionAuditWorkflow; null while the plan is pre-audit
  // or after a re-audit that hasn't finished yet. Release readiness is
  // "this FK is set AND the referenced report has outcome='pass'".
  //
  // `AnyPgColumn` annotation breaks the TypeScript inference cycle:
  // plans → completion_audit_reports → plans. The runtime FK is still
  // declared in the migration.
  completionAuditReportId: uuid("completion_audit_report_id").references(
    (): AnyPgColumn => completionAuditReports.id,
    { onDelete: "set null" },
  ),
  // Layer-A milestone-decomposition provenance. Populated only for plans
  // generated via the spec → manifest → milestone-plan path. The DB-level
  // CHECK constraint pairs `decomposition_id` with `milestone_id` (both
  // present or both null).
  decompositionId: uuid("decomposition_id").references(
    (): AnyPgColumn => specDecompositions.id,
    { onDelete: "set null" },
  ),
  milestoneId: text("milestone_id"),
  // Reserved for future auto-chaining. Always null in v0.9; the column
  // exists so plans persisted now stay forward-compatible.
  predecessorPlanId: uuid("predecessor_plan_id").references(
    (): AnyPgColumn => plans.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export type PlansRow = typeof plans.$inferSelect;
export type PlansInsert = typeof plans.$inferInsert;
