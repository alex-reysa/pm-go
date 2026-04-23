import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";

import type {
  ApprovalRequest,
  UUID,
} from "@pm-go/contracts";
import { approvalRequests, type PmGoDb } from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

/**
 * Phase 7 — durable human-approval ledger surface.
 *
 * `GET /approvals?planId=<uuid>` lists every `approval_requests` row
 * scoped to a plan, ordered by `requestedAt` desc. The list is the read
 * model the TUI uses to render its operator approvals screen and to
 * decide whether the `g A` chord is enabled.
 *
 * Mutation lives on the per-subject endpoints
 * (`POST /tasks/:id/approve`, `POST /plans/:id/approve`) — they share
 * the same idempotent flip-status helper exported here so the policy
 * remains "this row is approved iff its `status='approved'`".
 */
export interface ApprovalsRouteDeps {
  db: PmGoDb;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createApprovalsRoute(deps: ApprovalsRouteDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const planId = c.req.query("planId");
    if (planId === undefined || !isUuid(planId)) {
      return c.json({ error: "planId query param must be a UUID" }, 400);
    }

    const rows = await deps.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.planId, planId))
      .orderBy(desc(approvalRequests.requestedAt));

    return c.json(
      {
        planId,
        approvals: rows.map(rowToContract),
      },
      200,
    );
  });

  return app;
}

/**
 * Idempotent flip — used by both `POST /tasks/:id/approve` and
 * `POST /plans/:id/approve`. Returns the updated row if a matching
 * `pending` row existed (and was flipped to `approved`); returns
 * `null` when nothing matched (caller surfaces a 404 / 409 as
 * appropriate). Only `pending` rows are flipped — calling twice on the
 * same row is a no-op the second time.
 */
export async function approveSubject(
  db: PmGoDb,
  scope:
    | { kind: "task"; planId?: UUID; taskId: UUID }
    | { kind: "plan"; planId: UUID },
  approvedBy: string | undefined,
): Promise<ApprovalRequest | null> {
  const decidedAt = new Date().toISOString();

  if (scope.kind === "task") {
    // Flip the most recent pending row for this task. Multiple rows
    // can exist (e.g. re-driven workflow after a previous rejection)
    // but only the latest pending one is the live approval target.
    const [latest] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.taskId, scope.taskId),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(1);
    if (!latest) return null;

    await db
      .update(approvalRequests)
      .set({
        status: "approved",
        ...(approvedBy ? { approvedBy } : {}),
        decidedAt,
      })
      .where(eq(approvalRequests.id, latest.id));

    const [refetched] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, latest.id))
      .limit(1);
    return refetched ? rowToContract(refetched) : null;
  }

  // plan-scoped
  const [latest] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.planId, scope.planId),
        eq(approvalRequests.subject, "plan"),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(1);
  if (!latest) return null;

  await db
    .update(approvalRequests)
    .set({
      status: "approved",
      ...(approvedBy ? { approvedBy } : {}),
      decidedAt,
    })
    .where(eq(approvalRequests.id, latest.id));

  const [refetched] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, latest.id))
    .limit(1);
  return refetched ? rowToContract(refetched) : null;
}

function rowToContract(
  row: typeof approvalRequests.$inferSelect,
): ApprovalRequest {
  return {
    id: row.id,
    planId: row.planId,
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    subject: row.subject as "plan" | "task",
    riskBand: row.riskBand as "high" | "catastrophic",
    status: row.status as "pending" | "approved" | "rejected",
    ...(row.requestedBy !== null ? { requestedBy: row.requestedBy } : {}),
    ...(row.approvedBy !== null ? { approvedBy: row.approvedBy } : {}),
    requestedAt: toIso(row.requestedAt),
    ...(row.decidedAt !== null ? { decidedAt: toIso(row.decidedAt) } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  };
}
