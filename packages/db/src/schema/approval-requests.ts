import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { plans } from "./plans.js";
import { planTasks } from "./plan-tasks.js";

/**
 * Phase 7 (Worker 1) — durable human-approval ledger.
 *
 * One row per "this plan or task needs a human thumbs-up before merge".
 * Written by the policy engine via Worker 4's `persistApprovalRequest`
 * activity; mutated by `POST /plans/:id/approve` and
 * `POST /tasks/:id/approve`. The orchestration workflow blocks on
 * `status = 'approved'` before releasing high-risk work downstream.
 *
 * Columns follow the Phase 7 hyper-prompt's explicit migration shape
 * (text + CHECK rather than pgEnum) so that adding a new band or
 * status in a later phase does not require a follow-up `ALTER TYPE`.
 *
 * Migration: `db/migrations/0010_approval_requests.sql`.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    // Null when subject === 'plan'; required when subject === 'task'
    // (enforced by the subject_task_requires_task_id check below).
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "cascade",
    }),
    subject: text("subject").notNull(),
    riskBand: text("risk_band").notNull(),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    reason: text("reason"),
  },
  (table) => ({
    subjectCheck: check(
      "approval_requests_subject_check",
      sql`${table.subject} in ('plan', 'task')`,
    ),
    riskBandCheck: check(
      "approval_requests_risk_band_check",
      sql`${table.riskBand} in ('high', 'catastrophic')`,
    ),
    statusCheck: check(
      "approval_requests_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected')`,
    ),
    subjectTaskLinkCheck: check(
      "approval_requests_subject_task_link_check",
      sql`(${table.subject} = 'task' and ${table.taskId} is not null)
          or (${table.subject} = 'plan' and ${table.taskId} is null)`,
    ),
    planStatusIdx: index("approval_requests_plan_status_idx").on(
      table.planId,
      table.status,
    ),
  }),
);

export type ApprovalRequestsRow = typeof approvalRequests.$inferSelect;
export type ApprovalRequestsInsert = typeof approvalRequests.$inferInsert;
