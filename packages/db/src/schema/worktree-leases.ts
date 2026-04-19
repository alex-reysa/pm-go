import { sql } from "drizzle-orm";
import {
  check,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { phases } from "./phases.js";
import { planTasks } from "./plan-tasks.js";

export const worktreeLeaseStatus = pgEnum("worktree_lease_status", [
  "active",
  "expired",
  "released",
  "revoked",
]);

/**
 * Lease kind — Phase 5 adds `integration` for the per-phase integration
 * worktree that `PhaseIntegrationWorkflow` owns. `task` leases remain
 * scoped to a single plan_task row; `integration` leases are scoped to a
 * phase. The check constraint below enforces that task_id / phase_id are
 * exactly the right one for each kind.
 */
export const worktreeLeaseKind = pgEnum("worktree_lease_kind", [
  "task",
  "integration",
]);

export const worktreeLeases = pgTable(
  "worktree_leases",
  {
    id: uuid("id").primaryKey(),
    // Populated for kind='task'; null for kind='integration'.
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "cascade",
    }),
    // Populated for kind='integration'; null for kind='task'.
    phaseId: uuid("phase_id").references(() => phases.id, {
      onDelete: "cascade",
    }),
    kind: worktreeLeaseKind("kind").notNull().default("task"),
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
    // kind='task' → task_id NOT NULL, phase_id NULL.
    // kind='integration' → task_id NULL, phase_id NOT NULL.
    kindCorrelation: check(
      "worktree_leases_kind_correlation",
      sql`(
        (${table.kind} = 'task' AND ${table.taskId} IS NOT NULL AND ${table.phaseId} IS NULL)
        OR
        (${table.kind} = 'integration' AND ${table.taskId} IS NULL AND ${table.phaseId} IS NOT NULL)
      )`,
    ),
    // At most one active lease per task (Phase 3 invariant) — scoped to
    // kind='task' so integration leases don't collide with the same
    // partial index.
    activeLeasePerTask: uniqueIndex("worktree_leases_task_active_unique")
      .on(table.taskId)
      .where(sql`${table.status} = 'active' AND ${table.kind} = 'task'`),
    // At most one active integration lease per phase.
    activeLeasePerPhase: uniqueIndex("worktree_leases_phase_active_unique")
      .on(table.phaseId)
      .where(
        sql`${table.status} = 'active' AND ${table.kind} = 'integration'`,
      ),
  }),
);

export type WorktreeLeaseRow = typeof worktreeLeases.$inferSelect;
export type WorktreeLeaseInsert = typeof worktreeLeases.$inferInsert;
