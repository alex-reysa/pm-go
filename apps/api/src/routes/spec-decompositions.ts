import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { Client as TemporalClient } from "@temporalio/client";

import {
  auditMilestoneManifest,
  validateMilestoneManifest,
  type MilestoneContext,
  type SpecDecomposition,
  type SpecDecompositionWorkflowInput,
  type SpecToPlanWorkflowInput,
  type UUID,
} from "@pm-go/contracts";
import {
  plans,
  repoSnapshots,
  specDecompositions,
  specDocuments,
  type PmGoDb,
} from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

export interface SpecDecompositionsRouteDeps {
  temporal: TemporalClient;
  taskQueue: string;
  db: PmGoDb;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Layer-A milestone-decomposition routes. Mounted at `/spec-documents`
 * so all four endpoints share the canonical `/:specDocumentId/...`
 * shape:
 *
 * - `POST   /:id/decompose`
 * - `GET    /:id/decompositions/:decompositionId`
 * - `PUT    /:id/decompositions/:decompositionId/manifest`
 * - `POST   /:id/decompositions/:decompositionId/plan-first`
 *
 * The route module is intentionally separate from
 * `spec-documents.ts` because that one only owns spec-document
 * intake and would otherwise grow Temporal + plan persistence
 * responsibilities. Dual-mounting on the same prefix lets each
 * concern stay testable in isolation.
 */
export function createSpecDecompositionsRoute(
  deps: SpecDecompositionsRouteDeps,
) {
  const app = new Hono();

  // POST /spec-documents/:specDocumentId/decompose
  // Starts a SpecDecompositionWorkflow against the persisted spec +
  // repo snapshot pair. Returns 202 with the API-supplied
  // `decompositionId` so callers can immediately poll the GET endpoint.
  app.post("/:specDocumentId/decompose", async (c) => {
    const specDocumentId = c.req.param("specDocumentId");
    if (!isUuid(specDocumentId)) {
      return c.json({ error: "specDocumentId must be a UUID" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      repoSnapshotId?: unknown;
      requestedBy?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return c.json({ error: "missing JSON body" }, 400);
    }
    if (!isUuid(body.repoSnapshotId)) {
      return c.json({ error: "repoSnapshotId must be a UUID" }, 400);
    }
    const requestedBy =
      typeof body.requestedBy === "string" &&
      body.requestedBy.trim().length > 0
        ? body.requestedBy
        : "api";

    // Verify the spec document AND repo snapshot exist so the 202 we
    // hand back is not a promise the workflow can't keep. The workflow
    // itself would fail on the FK insert, but at that point the API
    // has already returned a `decompositionId` the client will poll
    // forever (the row is never created so `GET .../decompositions/:id`
    // 404s indefinitely). Validating both up front converts the FK
    // failure into an immediate 4xx the client can act on.
    const [specRow] = await deps.db
      .select({ id: specDocuments.id })
      .from(specDocuments)
      .where(eq(specDocuments.id, specDocumentId))
      .limit(1);
    if (!specRow) {
      return c.json(
        { error: `spec document ${specDocumentId} not found` },
        404,
      );
    }
    const [snapshotRow] = await deps.db
      .select({ id: repoSnapshots.id })
      .from(repoSnapshots)
      .where(eq(repoSnapshots.id, body.repoSnapshotId))
      .limit(1);
    if (!snapshotRow) {
      return c.json(
        { error: `repo snapshot ${body.repoSnapshotId} not found` },
        404,
      );
    }

    const decompositionId = randomUUID();
    const input: SpecDecompositionWorkflowInput = {
      decompositionId,
      specDocumentId,
      repoSnapshotId: body.repoSnapshotId,
      requestedBy,
    };

    const handle = await deps.temporal.workflow.start(
      "SpecDecompositionWorkflow",
      {
        args: [input],
        taskQueue: deps.taskQueue,
        // One-per-decomposition so concurrent operator clicks can't
        // collide. `decompositionId` is a fresh UUID per call so the
        // workflow id is never reused.
        workflowId: `spec-decompose-${decompositionId}`,
      },
    );

    return c.json(
      {
        decompositionId,
        workflowRunId: handle.firstExecutionRunId,
      },
      202,
    );
  });

  // GET /spec-documents/:specDocumentId/decompositions/:decompositionId
  app.get("/:specDocumentId/decompositions/:decompositionId", async (c) => {
    const specDocumentId = c.req.param("specDocumentId");
    const decompositionId = c.req.param("decompositionId");
    if (!isUuid(specDocumentId)) {
      return c.json({ error: "specDocumentId must be a UUID" }, 400);
    }
    if (!isUuid(decompositionId)) {
      return c.json({ error: "decompositionId must be a UUID" }, 400);
    }

    const [row] = await deps.db
      .select()
      .from(specDecompositions)
      .where(
        and(
          eq(specDecompositions.id, decompositionId),
          eq(specDecompositions.specDocumentId, specDocumentId),
        ),
      )
      .limit(1);
    if (!row) {
      return c.json(
        {
          error: `decomposition ${decompositionId} for spec ${specDocumentId} not found`,
        },
        404,
      );
    }

    return c.json({ decomposition: rowToContract(row) }, 200);
  });

  // PUT /spec-documents/:specDocumentId/decompositions/:decompositionId/manifest
  // Replaces the manifest with an operator-edited copy. Rejected if any
  // plan already references this decomposition row — once a plan is
  // generated from a milestone, the manifest is provenance and can't
  // shift under it.
  app.put(
    "/:specDocumentId/decompositions/:decompositionId/manifest",
    async (c) => {
      const specDocumentId = c.req.param("specDocumentId");
      const decompositionId = c.req.param("decompositionId");
      if (!isUuid(specDocumentId)) {
        return c.json({ error: "specDocumentId must be a UUID" }, 400);
      }
      if (!isUuid(decompositionId)) {
        return c.json({ error: "decompositionId must be a UUID" }, 400);
      }

      const body = (await c.req.json().catch(() => null)) as {
        manifest?: unknown;
      } | null;
      if (!body || typeof body !== "object") {
        return c.json({ error: "missing JSON body" }, 400);
      }
      if (!validateMilestoneManifest(body.manifest)) {
        return c.json(
          { error: "manifest failed MilestoneManifestSchema validation" },
          400,
        );
      }
      const auditIssues = auditMilestoneManifest(body.manifest);
      if (auditIssues.length > 0) {
        return c.json(
          {
            error: "manifest failed cross-element audit",
            issues: auditIssues,
          },
          400,
        );
      }
      if (body.manifest.specDocumentId !== specDocumentId) {
        return c.json(
          {
            error: `manifest.specDocumentId (${body.manifest.specDocumentId}) does not match URL specDocumentId (${specDocumentId})`,
          },
          400,
        );
      }

      // Look up the existing row and confirm its FKs still match the
      // path. (A 404 here means either the decomposition does not
      // exist, or it belongs to a different spec — both surface as
      // 404 rather than 403 for simplicity.)
      const [row] = await deps.db
        .select()
        .from(specDecompositions)
        .where(
          and(
            eq(specDecompositions.id, decompositionId),
            eq(specDecompositions.specDocumentId, specDocumentId),
          ),
        )
        .limit(1);
      if (!row) {
        return c.json(
          {
            error: `decomposition ${decompositionId} for spec ${specDocumentId} not found`,
          },
          404,
        );
      }
      if (body.manifest.repoSnapshotId !== row.repoSnapshotId) {
        return c.json(
          {
            error: `manifest.repoSnapshotId does not match decomposition row's repoSnapshotId`,
          },
          400,
        );
      }
      if (row.status !== "ready") {
        return c.json(
          {
            error: `decomposition ${decompositionId} is in status '${row.status}'; manifest can only be edited after the decomposer reaches 'ready'`,
          },
          409,
        );
      }

      // Provenance lock #1: once `plan-first` has started a
      // SpecToPlanWorkflow, the manifest is frozen even if the plan
      // row hasn't been persisted yet. Without this, a manifest edit
      // that races against an in-flight plan workflow leaves plan
      // provenance pointing at a manifest the plan never planned
      // against.
      if (row.planFirstStartedAt !== null) {
        return c.json(
          {
            error: `decomposition ${decompositionId} has plan-first in flight (since ${toIso(row.planFirstStartedAt)}); manifest is frozen`,
          },
          409,
        );
      }

      // Provenance lock #2: if any plan was already persisted from this
      // decomposition, the manifest is also frozen. Belt-and-braces with
      // lock #1 — plan-first sets the timestamp synchronously, so this
      // branch should be unreachable in practice, but it survives a
      // hypothetical operator-side row insert.
      const [existingPlan] = await deps.db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.decompositionId, decompositionId))
        .limit(1);
      if (existingPlan) {
        return c.json(
          {
            error: `decomposition ${decompositionId} already has a plan (${existingPlan.id}); manifest is frozen`,
          },
          409,
        );
      }

      const now = new Date().toISOString();
      const [updated] = await deps.db
        .update(specDecompositions)
        .set({ manifest: body.manifest, updatedAt: now })
        .where(eq(specDecompositions.id, decompositionId))
        .returning();
      if (!updated) {
        return c.json(
          { error: `decomposition ${decompositionId} disappeared mid-update` },
          500,
        );
      }
      return c.json({ decomposition: rowToContract(updated) }, 200);
    },
  );

  // POST /spec-documents/:specDocumentId/decompositions/:decompositionId/plan-first
  // Starts a `SpecToPlanWorkflow` for the decomposition's first
  // milestone (`milestones[0]`). The workflow's planner activity sees
  // the milestone context and narrows its prompt accordingly; the
  // resulting plan row is stamped with `decomposition_id` and
  // `milestone_id` for round-trip provenance.
  app.post(
    "/:specDocumentId/decompositions/:decompositionId/plan-first",
    async (c) => {
      const specDocumentId = c.req.param("specDocumentId");
      const decompositionId = c.req.param("decompositionId");
      if (!isUuid(specDocumentId)) {
        return c.json({ error: "specDocumentId must be a UUID" }, 400);
      }
      if (!isUuid(decompositionId)) {
        return c.json({ error: "decompositionId must be a UUID" }, 400);
      }
      const body = (await c.req.json().catch(() => null)) as {
        requestedBy?: unknown;
      } | null;
      const requestedBy =
        body &&
        typeof body.requestedBy === "string" &&
        body.requestedBy.trim().length > 0
          ? body.requestedBy
          : "api";

      const [row] = await deps.db
        .select()
        .from(specDecompositions)
        .where(
          and(
            eq(specDecompositions.id, decompositionId),
            eq(specDecompositions.specDocumentId, specDocumentId),
          ),
        )
        .limit(1);
      if (!row) {
        return c.json(
          {
            error: `decomposition ${decompositionId} for spec ${specDocumentId} not found`,
          },
          404,
        );
      }
      if (row.status !== "ready" || row.manifest === null) {
        return c.json(
          {
            error: `decomposition ${decompositionId} is in status '${row.status}'; plan-first requires status='ready'`,
          },
          409,
        );
      }

      const firstMilestone = row.manifest.milestones[0];
      if (firstMilestone === undefined) {
        return c.json(
          { error: `decomposition ${decompositionId} has no milestones` },
          409,
        );
      }

      // Idempotency: refuse if another plan already exists for this
      // decomposition. The spike does not auto-chain, so a second
      // call would orphan a plan against the same milestone with no
      // way for the operator to choose which one is authoritative.
      const [conflict] = await deps.db
        .select({ id: plans.id })
        .from(plans)
        .where(
          and(
            eq(plans.decompositionId, decompositionId),
            // Defensive: a future auto-chain pass might insert plans
            // against later milestones too. For now we only block on
            // the same milestone.
            eq(plans.milestoneId, firstMilestone.id),
          ),
        )
        .limit(1);
      if (conflict) {
        return c.json(
          {
            error: `plan ${conflict.id} already exists for decomposition ${decompositionId} milestone ${firstMilestone.id}`,
          },
          409,
        );
      }

      // Atomically claim the manifest lock BEFORE starting the
      // workflow. The conditional `plan_first_started_at IS NULL`
      // makes a concurrent second `plan-first` call short-circuit to
      // 409 without ever calling `workflow.start`. This closes the
      // window during which a `PUT /manifest` could land between
      // accepting plan-first and the eventual `persistPlan` write.
      const lockClaimedAt = new Date().toISOString();
      const [locked] = await deps.db
        .update(specDecompositions)
        .set({
          planFirstStartedAt: lockClaimedAt,
          updatedAt: lockClaimedAt,
        })
        .where(
          and(
            eq(specDecompositions.id, decompositionId),
            isNull(specDecompositions.planFirstStartedAt),
          ),
        )
        .returning({ id: specDecompositions.id });
      if (!locked) {
        return c.json(
          {
            error: `decomposition ${decompositionId} already has plan-first in flight`,
          },
          409,
        );
      }

      const planId = randomUUID();
      const milestoneContext: MilestoneContext = {
        decompositionId,
        milestoneId: firstMilestone.id,
        manifest: row.manifest,
      };
      const input: SpecToPlanWorkflowInput = {
        planId,
        specDocumentId,
        repoSnapshotId: row.repoSnapshotId,
        requestedBy,
        milestoneContext,
      };

      try {
        const handle = await deps.temporal.workflow.start(
          "SpecToPlanWorkflow",
          {
            args: [input],
            taskQueue: deps.taskQueue,
            // Differentiate from the full-spec `plan-${specDocumentId}`
            // workflow id so the two routes never collide on
            // workflow-id reuse if both are exercised against the same
            // spec.
            workflowId: `plan-${decompositionId}-${firstMilestone.id}`,
          },
        );

        return c.json(
          {
            planId,
            decompositionId,
            milestoneId: firstMilestone.id,
            workflowRunId: handle.firstExecutionRunId,
          },
          202,
        );
      } catch (err) {
        // Roll the lock back so a follow-up plan-first attempt isn't
        // permanently blocked by a transient `workflow.start` failure
        // (Temporal unreachable, namespace drift, etc.). Operator
        // sees the original error; the row goes back to its prior
        // state.
        await deps.db
          .update(specDecompositions)
          .set({ planFirstStartedAt: null, updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(specDecompositions.id, decompositionId),
              eq(specDecompositions.planFirstStartedAt, lockClaimedAt),
            ),
          );
        throw err;
      }
    },
  );

  // Reference `ne` from drizzle-orm so the import isn't dropped — it's
  // available for follow-up endpoints (e.g. listing decompositions
  // whose status is not 'failed') without having to re-add the import.
  void ne;

  return app;
}

function rowToContract(row: {
  id: string;
  specDocumentId: string;
  repoSnapshotId: string;
  status: string;
  manifest: import("@pm-go/contracts").MilestoneManifest | null;
  errorReason: string | null;
  planFirstStartedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}): SpecDecomposition {
  // Build the optional fields up explicitly rather than via conditional
  // spread — `exactOptionalPropertyTypes: true` rejects `manifest?: T |
  // undefined`, so the spread form widens to a non-assignable shape.
  const out: SpecDecomposition = {
    id: row.id,
    specDocumentId: row.specDocumentId,
    repoSnapshotId: row.repoSnapshotId,
    status: row.status as SpecDecomposition["status"],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.manifest !== null) {
    out.manifest = row.manifest;
  }
  if (row.errorReason !== null) {
    out.errorReason = row.errorReason;
  }
  if (row.planFirstStartedAt !== undefined && row.planFirstStartedAt !== null) {
    out.planFirstStartedAt = toIso(row.planFirstStartedAt);
  }
  return out;
}
