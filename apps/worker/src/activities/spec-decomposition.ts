import type {
  AgentRun,
  MilestoneManifest,
  SpecDecomposition,
} from "@pm-go/contracts";
import {
  agentRuns,
  specDecompositions,
  type PmGoDb,
} from "@pm-go/db";
import type { DecomposerRunner } from "@pm-go/executor-claude";
import {
  MilestoneManifestValidationError,
  runDecomposer,
} from "@pm-go/planner";
import { eq } from "drizzle-orm";

import { createPlanPersistenceActivities } from "./plan-persistence.js";

export interface SpecDecompositionActivityDeps {
  db: PmGoDb;
  decomposerRunner: DecomposerRunner;
  decomposerMaxTurns?: number;
  decomposerBudgetUsd?: number;
  /** Claude model id. When unset, the planner package default applies. */
  decomposerModel?: string;
}

export interface SpecDecompositionActivities {
  /**
   * Run the decomposer agent against the persisted spec + repo snapshot
   * and return both the manifest and the planner-shape AgentRun row that
   * should be persisted alongside it.
   *
   * The activity itself does NOT persist anything — the workflow is
   * responsible for sequencing the AgentRun + decomposition writes so a
   * crash between them is recoverable.
   */
  runDecomposerActivity(input: {
    specDocumentId: string;
    repoSnapshotId: string;
    requestedBy: string;
  }): Promise<{ manifest: MilestoneManifest; agentRun: AgentRun }>;
  /**
   * Insert the initial `pending` decomposition row so the API can poll
   * `GET /spec-documents/:id/decompositions/:decompositionId` immediately
   * after the workflow starts. Idempotent on the supplied id.
   */
  initSpecDecomposition(input: {
    decompositionId: string;
    specDocumentId: string;
    repoSnapshotId: string;
  }): Promise<void>;
  /**
   * Flip the decomposition row to `ready` and store the manifest. Bumps
   * `updated_at` to now.
   */
  finalizeSpecDecompositionReady(input: {
    decompositionId: string;
    manifest: MilestoneManifest;
  }): Promise<SpecDecomposition>;
  /**
   * Flip the decomposition row to `failed` with a sanitized
   * `error_reason`. Used by the workflow's catch path so a terminal
   * failure leaves an inspectable row instead of a stuck `running` one.
   */
  finalizeSpecDecompositionFailed(input: {
    decompositionId: string;
    errorReason: string;
  }): Promise<SpecDecomposition>;
  /**
   * Idempotent transition `pending → running`. Called after
   * `initSpecDecomposition` and before invoking the decomposer agent so
   * a poll observes the workflow is in flight, not stuck at pending.
   */
  markSpecDecompositionRunning(input: {
    decompositionId: string;
  }): Promise<void>;
}

export function createSpecDecompositionActivities(
  deps: SpecDecompositionActivityDeps,
): SpecDecompositionActivities {
  const { db } = deps;
  // Reuse the plan-persistence loaders so we have exactly one
  // implementation of "fetch a SpecDocument/RepoSnapshot by id" across
  // the worker.
  const persistence = createPlanPersistenceActivities({ db });

  return {
    async runDecomposerActivity(input) {
      const specDocument = await persistence.loadSpecDocument(
        input.specDocumentId,
      );
      const repoSnapshot = await persistence.loadRepoSnapshot(
        input.repoSnapshotId,
      );
      const { manifest, agentRun } = await runDecomposer({
        specDocument,
        repoSnapshot,
        requestedBy: input.requestedBy,
        runner: deps.decomposerRunner,
        ...(deps.decomposerMaxTurns !== undefined
          ? { maxTurnsCap: deps.decomposerMaxTurns }
          : {}),
        ...(deps.decomposerBudgetUsd !== undefined
          ? { budgetUsdCap: deps.decomposerBudgetUsd }
          : {}),
        ...(deps.decomposerModel !== undefined
          ? { model: deps.decomposerModel }
          : {}),
      });
      return { manifest, agentRun };
    },

    async initSpecDecomposition(input) {
      const now = new Date().toISOString();
      await db
        .insert(specDecompositions)
        .values({
          id: input.decompositionId,
          specDocumentId: input.specDocumentId,
          repoSnapshotId: input.repoSnapshotId,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: specDecompositions.id });
    },

    async markSpecDecompositionRunning(input) {
      const now = new Date().toISOString();
      await db
        .update(specDecompositions)
        .set({ status: "running", updatedAt: now })
        .where(eq(specDecompositions.id, input.decompositionId));
    },

    async finalizeSpecDecompositionReady(input) {
      const now = new Date().toISOString();
      const [row] = await db
        .update(specDecompositions)
        .set({
          status: "ready",
          manifest: input.manifest,
          errorReason: null,
          updatedAt: now,
        })
        .where(eq(specDecompositions.id, input.decompositionId))
        .returning();
      if (!row) {
        throw new Error(
          `finalizeSpecDecompositionReady: row ${input.decompositionId} not found`,
        );
      }
      return rowToSpecDecomposition(row);
    },

    async finalizeSpecDecompositionFailed(input) {
      const now = new Date().toISOString();
      const [row] = await db
        .update(specDecompositions)
        .set({
          status: "failed",
          errorReason: input.errorReason,
          updatedAt: now,
        })
        .where(eq(specDecompositions.id, input.decompositionId))
        .returning();
      if (!row) {
        throw new Error(
          `finalizeSpecDecompositionFailed: row ${input.decompositionId} not found`,
        );
      }
      return rowToSpecDecomposition(row);
    },
  };
}

/**
 * Pure mapping from `spec_decompositions` row to the contract shape.
 * Exported so the API route can reuse it on `GET .../decompositions/:id`.
 */
export function rowToSpecDecomposition(row: {
  id: string;
  specDocumentId: string;
  repoSnapshotId: string;
  status: string;
  manifest: MilestoneManifest | null;
  errorReason: string | null;
  planFirstStartedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}): SpecDecomposition {
  const out: SpecDecomposition = {
    id: row.id,
    specDocumentId: row.specDocumentId,
    repoSnapshotId: row.repoSnapshotId,
    status: row.status as SpecDecomposition["status"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.manifest !== null) out.manifest = row.manifest;
  if (row.errorReason !== null) out.errorReason = row.errorReason;
  if (row.planFirstStartedAt !== undefined && row.planFirstStartedAt !== null) {
    out.planFirstStartedAt = row.planFirstStartedAt;
  }
  return out;
}

/**
 * Sanitized, operator-facing error_reason string. Mirrors the convention
 * `errorReasonFromClassified` uses on `agent_runs.error_reason` —
 * short, classified, no API keys or prompt bodies. Exported so the
 * workflow can map an exception caught at the workflow boundary into
 * a string without re-implementing the classification.
 */
export function errorReasonForDecomposerFailure(err: unknown): string {
  if (err instanceof MilestoneManifestValidationError) {
    const head = err.issues.slice(0, 3).join("; ");
    return head.length > 0
      ? `manifest validation failed: ${head}`
      : "manifest validation failed";
  }
  if (err instanceof Error) {
    // Strip newlines so the error_reason fits on one operator-facing
    // line in CLI / dashboard renderings.
    return err.message.split("\n", 1)[0]!.slice(0, 500);
  }
  return "unknown decomposer error";
}

// Keep the agentRuns import used: it is used by the workflow when the
// activity is wrapped to also persist the AgentRun row alongside the
// decomposition. Suppressed here because this activity intentionally
// stops short of the persistence so the workflow can sequence the
// writes.
void agentRuns;
