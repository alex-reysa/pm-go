import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { planTasks } from "./plan-tasks.js";

export const worktreeLeaseStatus = pgEnum("worktree_lease_status", [
  "active",
  "expired",
  "released",
  "revoked",
]);

export const worktreeLeases = pgTable(
  "worktree_leases",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => planTasks.id, { onDelete: "cascade" }),
    repoRoot: text("repo_root").notNull(),
    branchName: text("branch_name").notNull(),
    worktreePath: text("worktree_path").notNull(),
    baseSha: text("base_sha").notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    status: worktreeLeaseStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Partial unique index: at most one active lease per task. A task may
    // re-lease after the previous lease transitions to released/expired/
    // revoked, so the constraint only fires on status='active'.
    activeLeasePerTask: uniqueIndex("worktree_leases_task_active_unique")
      .on(table.taskId)
      .where(sql`${table.status} = 'active'`),
  }),
);

export type WorktreeLeaseRow = typeof worktreeLeases.$inferSelect;
export type WorktreeLeaseInsert = typeof worktreeLeases.$inferInsert;
