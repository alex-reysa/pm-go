import { desc, eq, max } from "drizzle-orm";

import type {
  PolicyDecision,
  UUID,
} from "@pm-go/contracts";
import type { StoredReviewReport } from "@pm-go/temporal-activities";
import {
  planTasks,
  policyDecisions,
  reviewReports,
  type PmGoDb,
} from "@pm-go/db";
import { createSpanWriter, withSpan } from "@pm-go/observability";

export interface ReviewPersistenceDeps {
  db: PmGoDb;
}

export interface ReviewPersistenceActivities {
  persistReviewReport(report: StoredReviewReport): Promise<UUID>;
  loadReviewReport(reportId: UUID): Promise<StoredReviewReport | null>;
  loadLatestReviewReport(taskId: UUID): Promise<StoredReviewReport | null>;
  loadReviewReportsByTask(taskId: UUID): Promise<StoredReviewReport[]>;
  countFixCyclesForTask(taskId: UUID): Promise<number>;
  persistPolicyDecision(decision: PolicyDecision): Promise<UUID>;
}

/**
 * Persistence layer for Phase 4 review reports + policy decisions.
 *
 * - `persistReviewReport` uses ON CONFLICT (id) DO NOTHING so Temporal
 *   activity retries after a successful write are a no-op rather than a
 *   duplicate-key crash. The `(task_id, cycle_number)` unique constraint
 *   protects against a different retry hazard (re-running with a fresh id
 *   but the same cycle) — those surface as a db error so the caller can
 *   notice and recover.
 * - `persistPolicyDecision` uses the same ON CONFLICT (id) DO NOTHING
 *   pattern for the same reason; policy decisions are append-only, one
 *   row per decision event.
 * - The loaders deserialize the DB row back into the enriched
 *   `StoredReviewReport = ReviewReport & { cycleNumber }` shape used by
 *   the workflow layer.
 */
export function createReviewPersistenceActivities(
  deps: ReviewPersistenceDeps,
): ReviewPersistenceActivities {
  const { db } = deps;

  return {
    async persistReviewReport(report: StoredReviewReport): Promise<UUID> {
      const planId = await resolvePlanIdForTask(db, report.taskId);
      const sink = planId
        ? createSpanWriter({ db, planId }).writeSpan
        : undefined;
      return withSpan(
        "worker.activities.review-persistence.persistReviewReport",
        {
          ...(planId ? { planId } : {}),
          taskId: report.taskId,
          reportId: report.id,
          outcome: report.outcome,
        },
        async () => {
          await db
            .insert(reviewReports)
            .values({
              id: report.id,
              taskId: report.taskId,
              reviewerRunId: report.reviewerRunId,
              outcome: report.outcome,
              findings: report.findings,
              cycleNumber: report.cycleNumber,
              reviewedBaseSha: report.reviewedBaseSha,
              reviewedHeadSha: report.reviewedHeadSha,
              createdAt: report.createdAt,
            })
            .onConflictDoNothing({ target: reviewReports.id });
          return report.id;
        },
        sink ? { sink } : {},
      );
    },

    async loadReviewReport(
      reportId: UUID,
    ): Promise<StoredReviewReport | null> {
      const rows = await db
        .select()
        .from(reviewReports)
        .where(eq(reviewReports.id, reportId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return rowToStoredReport(row);
    },

    async loadLatestReviewReport(
      taskId: UUID,
    ): Promise<StoredReviewReport | null> {
      const rows = await db
        .select()
        .from(reviewReports)
        .where(eq(reviewReports.taskId, taskId))
        .orderBy(desc(reviewReports.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return rowToStoredReport(row);
    },

    async loadReviewReportsByTask(
      taskId: UUID,
    ): Promise<StoredReviewReport[]> {
      const rows = await db
        .select()
        .from(reviewReports)
        .where(eq(reviewReports.taskId, taskId))
        .orderBy(reviewReports.createdAt);
      return rows.map(rowToStoredReport);
    },

    async countFixCyclesForTask(taskId: UUID): Promise<number> {
      const rows = await db
        .select({ maxCycle: max(reviewReports.cycleNumber) })
        .from(reviewReports)
        .where(eq(reviewReports.taskId, taskId));
      const row = rows[0];
      // `max` over an empty set yields null/undefined; treat as zero cycles.
      const raw = row?.maxCycle ?? 0;
      return typeof raw === "number" ? raw : Number(raw);
    },

    async persistPolicyDecision(decision: PolicyDecision): Promise<UUID> {
      // Append-only — one row per decision event. ON CONFLICT (id) DO
      // NOTHING keeps Temporal retries idempotent without masking
      // bookkeeping errors (a duplicate id with different fields still
      // surfaces when the caller tries to update via a separate code path).
      // Span sink: scope by the plan inferred from the subject. Tasks
      // resolve through plan_tasks; plan-scoped decisions use the
      // subjectId verbatim.
      let planId: string | undefined;
      if (decision.subjectType === "task") {
        const resolved = await resolvePlanIdForTask(db, decision.subjectId);
        planId = resolved ?? undefined;
      } else if (decision.subjectType === "plan") {
        planId = decision.subjectId;
      }
      const sink = planId
        ? createSpanWriter({ db, planId }).writeSpan
        : undefined;
      return withSpan(
        "worker.activities.review-persistence.persistPolicyDecision",
        {
          ...(planId ? { planId } : {}),
          subjectType: decision.subjectType,
          subjectId: decision.subjectId,
          decision: decision.decision,
        },
        async () => {
          await db
            .insert(policyDecisions)
            .values({
              id: decision.id,
              subjectType: decision.subjectType,
              subjectId: decision.subjectId,
              riskLevel: decision.riskLevel,
              decision: decision.decision,
              reason: decision.reason,
              actor: decision.actor,
              createdAt: decision.createdAt,
            })
            .onConflictDoNothing({ target: policyDecisions.id });
          return decision.id;
        },
        sink ? { sink } : {},
      );
    },
  };
}

async function resolvePlanIdForTask(
  db: PmGoDb,
  taskId: UUID,
): Promise<string | null> {
  const [row] = await db
    .select({ planId: planTasks.planId })
    .from(planTasks)
    .where(eq(planTasks.id, taskId))
    .limit(1);
  return row?.planId ?? null;
}

type ReviewReportsRow = typeof reviewReports.$inferSelect;

function rowToStoredReport(row: ReviewReportsRow): StoredReviewReport {
  return {
    id: row.id,
    taskId: row.taskId,
    reviewerRunId: row.reviewerRunId,
    outcome: row.outcome,
    findings: row.findings,
    createdAt: row.createdAt,
    cycleNumber: row.cycleNumber,
    reviewedBaseSha: row.reviewedBaseSha,
    reviewedHeadSha: row.reviewedHeadSha,
  };
}
