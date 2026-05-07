import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MilestoneManifest } from "@pm-go/contracts";

import { repoSnapshots } from "./repo-snapshots.js";
import { specDocuments } from "./spec-documents.js";

/**
 * Layer-A milestone decomposition spike (v0.9).
 *
 * Persists the decomposer agent's `MilestoneManifest` output, plus the
 * lifecycle state of the decomposition workflow that produced it. One
 * row per "decomposer run against (spec_document, repo_snapshot)" — the
 * `SpecDecompositionWorkflow` writes the row in `pending`, flips it to
 * `running` while the agent executes, and lands on `ready` (manifest
 * populated) or `failed` (`error_reason` populated).
 *
 * Database-level CHECK constraints enforce:
 * - status ∈ {pending, running, ready, failed}
 * - status = 'ready'  ⇒ manifest IS NOT NULL
 * - status = 'failed' ⇒ error_reason IS NOT NULL
 *
 * Migration: `db/migrations/0018_spec_decompositions.sql`.
 */
export const specDecompositions = pgTable(
  "spec_decompositions",
  {
    id: uuid("id").primaryKey(),
    specDocumentId: uuid("spec_document_id")
      .notNull()
      .references(() => specDocuments.id, { onDelete: "cascade" }),
    repoSnapshotId: uuid("repo_snapshot_id")
      .notNull()
      .references(() => repoSnapshots.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    manifest: jsonb("manifest").$type<MilestoneManifest>(),
    errorReason: text("error_reason"),
    /**
     * Set at the moment a `plan-first` request is accepted. Once
     * non-null, the manifest is frozen — `PUT /manifest` rejects
     * with 409 even if the eventual plan row hasn't been persisted
     * yet (the SpecToPlanWorkflow can take minutes between accept
     * and `persistPlan`). Acts as the durable lock the API holds
     * across that window so plan provenance never points at a
     * manifest that was edited mid-flight.
     */
    planFirstStartedAt: timestamp("plan_first_started_at", {
      withTimezone: true,
      mode: "string",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    specDocumentIdIdx: index("spec_decompositions_spec_document_id_idx").on(
      table.specDocumentId,
    ),
  }),
);

export type SpecDecompositionsRow = typeof specDecompositions.$inferSelect;
export type SpecDecompositionsInsert = typeof specDecompositions.$inferInsert;
