import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { riskLevel } from "./plan-tasks.js";

export const policySubjectType = pgEnum("policy_subject_type", [
  "plan",
  "task",
  "merge",
  "review",
]);

export const policyDecisionType = pgEnum("policy_decision_type", [
  "approved",
  "rejected",
  "requires_human",
  "budget_exceeded",
  "scope_violation",
  "retry_allowed",
  "retry_denied",
]);

export const policyActor = pgEnum("policy_actor", ["system", "human"]);

export const policyDecisions = pgTable(
  "policy_decisions",
  {
    id: uuid("id").primaryKey(),
    subjectType: policySubjectType("subject_type").notNull(),
    // subjectId is a FK-less UUID because a PolicyDecision may target any
    // of plans/plan_tasks/merge_runs/review_reports. Application-level
    // code enforces that the id exists in the table implied by subjectType.
    subjectId: uuid("subject_id").notNull(),
    riskLevel: riskLevel("risk_level").notNull(),
    decision: policyDecisionType("decision").notNull(),
    reason: text("reason").notNull(),
    actor: policyActor("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Lookup "all decisions for this subject in chronological order" — the
    // bread-and-butter audit-trail query for task status investigations.
    subjectChronoIdx: index("policy_decisions_subject_chrono_idx").on(
      table.subjectType,
      table.subjectId,
      table.createdAt,
    ),
  }),
);

export type PolicyDecisionsRow = typeof policyDecisions.$inferSelect;
export type PolicyDecisionsInsert = typeof policyDecisions.$inferInsert;
