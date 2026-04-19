import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { UUID } from "@pm-go/contracts";
import { agentRuns } from "./agent-runs.js";
import { phases } from "./phases.js";
import { plans } from "./plans.js";
import { repoSnapshots } from "./repo-snapshots.js";
import { worktreeLeases } from "./worktree-leases.js";

/**
 * Phase 5 `merge_runs` table — one row per PhaseIntegrationWorkflow run.
 *
 * A MergeRun records the sequence of task-into-integration-branch merges
 * that produced the integrated phase state. `post_merge_snapshot_id` is
 * stamped AFTER a successful integration so the next phase's
 * `base_snapshot_id` can point at the exact repo state that phase audited
 * — this is the durable linkage `PhasePartitionWorkflow` relies on.
 */
export const mergeRuns = pgTable(
  "merge_runs",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => phases.id, { onDelete: "cascade" }),
    integrationBranch: text("integration_branch").notNull(),
    // Points at the worktree_leases row that hosts the integration
    // worktree (kind='integration'). Set null after the lease is
    // released so the merge_runs row survives lease cleanup.
    integrationLeaseId: uuid("integration_lease_id").references(
      () => worktreeLeases.id,
      { onDelete: "set null" },
    ),
    mergedTaskIds: jsonb("merged_task_ids")
      .$type<UUID[]>()
      .notNull()
      .default([]),
    failedTaskId: uuid("failed_task_id"),
    integrationHeadSha: text("integration_head_sha"),
    // The RepoSnapshot captured after the integration merge completed.
    // Null while the run is in flight; non-null on success.
    postMergeSnapshotId: uuid("post_merge_snapshot_id").references(
      () => repoSnapshots.id,
      { onDelete: "restrict" },
    ),
    // The AgentRun that actually executed the integration (role='integrator').
    // Left null if the merge is performed without an agent wrapper.
    integratorRunId: uuid("integrator_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => ({
    // At most one in-flight merge run per phase at a time.
    phaseInFlightUnique: uniqueIndex("merge_runs_phase_in_flight_unique")
      .on(table.phaseId)
      .where(sql`${table.completedAt} IS NULL`),
    // Chronological lookup "merge runs for this phase, newest first".
    phaseStartedIdx: index("merge_runs_phase_started_idx").on(
      table.phaseId,
      table.startedAt,
    ),
  }),
);

export type MergeRunsRow = typeof mergeRuns.$inferSelect;
export type MergeRunsInsert = typeof mergeRuns.$inferInsert;
