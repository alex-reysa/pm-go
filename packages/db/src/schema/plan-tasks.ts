import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AcceptanceCriterion,
  FileScope,
  ReviewPolicy,
  TaskBudget,
} from "@pm-go/contracts";
import { plans } from "./plans.js";
import { phases } from "./phases.js";

export const taskKind = pgEnum("task_kind", [
  "foundation",
  "implementation",
  "review",
  "integration",
  "release",
]);

export const taskStatus = pgEnum("task_status", [
  "pending",
  "ready",
  "running",
  "in_review",
  "fixing",
  "ready_to_merge",
  "merged",
  "blocked",
  "failed",
]);

export const riskLevel = pgEnum("risk_level", ["low", "medium", "high"]);

export const taskSizeHint = pgEnum("task_size_hint", [
  "small",
  "medium",
  "large",
]);

export const planTasks = pgTable(
  "plan_tasks",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    kind: taskKind("kind").notNull(),
    status: taskStatus("status").notNull(),
    riskLevel: riskLevel("risk_level").notNull(),
    sizeHint: taskSizeHint("size_hint"),
    fileScope: jsonb("file_scope").$type<FileScope>().notNull(),
    acceptanceCriteria: jsonb("acceptance_criteria")
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default([]),
    testCommands: jsonb("test_commands")
      .$type<string[]>()
      .notNull()
      .default([]),
    budget: jsonb("budget").$type<TaskBudget>().notNull(),
    reviewerPolicy: jsonb("reviewer_policy").$type<ReviewPolicy>().notNull(),
    requiresHumanApproval: boolean("requires_human_approval")
      .notNull()
      .default(false),
    maxReviewFixCycles: integer("max_review_fix_cycles").notNull().default(2),
    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),
  },
  (table) => ({
    planSlugUnique: uniqueIndex("plan_tasks_plan_id_slug_unique").on(
      table.planId,
      table.slug,
    ),
  }),
);

export type PlanTasksRow = typeof planTasks.$inferSelect;
export type PlanTasksInsert = typeof planTasks.$inferInsert;
