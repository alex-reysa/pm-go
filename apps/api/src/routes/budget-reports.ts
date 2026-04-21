import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";

import type {
  BudgetReport,
  BudgetTaskBreakdown,
  UUID,
} from "@pm-go/contracts";
import {
  agentRuns,
  budgetReports,
  planTasks,
  type PmGoDb,
} from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

/**
 * Phase 7 — `GET /plans/:planId/budget-report`.
 *
 * Computes the plan-wide budget snapshot on every read by aggregating
 * `agent_runs` joined to `plan_tasks` joined to the plan. Persists
 * the result onto `budget_reports` so the audit trail captures
 * every read-driven snapshot. The TUI's budget panel + the smoke
 * harness consume this surface.
 *
 * Response shape mirrors the `BudgetReport` contract:
 *   { id, planId, totalUsd, totalTokens, totalWallClockMinutes,
 *     perTaskBreakdown[], generatedAt }
 *
 * Mounted at `/plans/:planId/budget-report` from `app.ts`. Lives in
 * its own file (rather than appended to plans.ts) so the policy
 * surface stays decoupled from the planning lifecycle endpoints —
 * a Phase 8 webhook on `BudgetReport.generatedAt` doesn't need to
 * pull in plans.ts's transitive imports.
 */
export interface BudgetReportsRouteDeps {
  db: PmGoDb;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createBudgetReportsRoute(deps: BudgetReportsRouteDeps) {
  const app = new Hono();

  // GET /plans/:planId/budget-report — see module docblock. The
  // route is mounted under /plans in app.ts so the path lands
  // exactly where the contract expects.
  app.get("/:planId/budget-report", async (c) => {
    const planId = c.req.param("planId");
    if (!isUuid(planId)) {
      return c.json({ error: "planId must be a UUID" }, 400);
    }
    const report = await aggregateBudget(deps.db, planId);
    // Persist the snapshot for audit-trail completeness. Best-effort —
    // a failed insert never blocks the operator from seeing a fresh
    // budget number on the read path.
    await persistBudgetReportRow(deps.db, report).catch(() => undefined);
    return c.json(report, 200);
  });

  return app;
}

/**
 * Pure read aggregation. Identical contract to the worker activity
 * `aggregateBudget` in `apps/worker/src/activities/policy.ts` — the
 * read API and the workflow-driven persist path stay byte-compatible
 * by both consuming this same helper. Keeping a separate copy on
 * the API side preserves the §10 invariant: `apps/api` MUST NOT
 * import `@pm-go/policy-engine` for non-policy reasons (a re-export
 * via the contracts surface is fine but the math itself is local).
 */
export async function aggregateBudget(
  db: PmGoDb,
  planId: UUID,
): Promise<BudgetReport> {
  const rows = await db
    .select({
      taskId: agentRuns.taskId,
      costUsd: agentRuns.costUsd,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      cacheCreationTokens: agentRuns.cacheCreationTokens,
      cacheReadTokens: agentRuns.cacheReadTokens,
      startedAt: agentRuns.startedAt,
      completedAt: agentRuns.completedAt,
    })
    .from(agentRuns)
    .innerJoin(planTasks, eq(planTasks.id, agentRuns.taskId))
    .where(eq(planTasks.planId, planId))
    .orderBy(asc(agentRuns.startedAt));

  const perTaskMap = new Map<UUID, BudgetTaskBreakdown>();
  let totalUsd = 0;
  let totalTokens = 0;
  let totalWallClockMinutes = 0;

  for (const row of rows) {
    if (!row.taskId) continue;
    const usd = row.costUsd === null ? 0 : Number(row.costUsd);
    const tokens =
      (row.inputTokens ?? 0) +
      (row.cacheCreationTokens ?? 0) +
      (row.cacheReadTokens ?? 0) +
      (row.outputTokens ?? 0);
    const minutes = minutesBetween(row.startedAt, row.completedAt);

    totalUsd += usd;
    totalTokens += tokens;
    totalWallClockMinutes += minutes;

    const prior = perTaskMap.get(row.taskId) ?? {
      taskId: row.taskId,
      totalUsd: 0,
      totalTokens: 0,
      totalWallClockMinutes: 0,
    };
    prior.totalUsd += usd;
    prior.totalTokens += tokens;
    prior.totalWallClockMinutes += minutes;
    perTaskMap.set(row.taskId, prior);
  }

  return {
    id: randomUUID(),
    planId,
    totalUsd: round6(totalUsd),
    totalTokens,
    totalWallClockMinutes: round3(totalWallClockMinutes),
    perTaskBreakdown: [...perTaskMap.values()].map((b) => ({
      taskId: b.taskId,
      totalUsd: round6(b.totalUsd),
      totalTokens: b.totalTokens,
      totalWallClockMinutes: round3(b.totalWallClockMinutes),
    })),
    generatedAt: new Date().toISOString(),
  };
}

async function persistBudgetReportRow(
  db: PmGoDb,
  report: BudgetReport,
): Promise<void> {
  await db.insert(budgetReports).values({
    id: report.id,
    planId: report.planId,
    totalUsd: report.totalUsd.toString(),
    totalTokens: report.totalTokens,
    totalWallClockMinutes: report.totalWallClockMinutes.toString(),
    perTaskBreakdown: report.perTaskBreakdown,
    generatedAt: report.generatedAt,
  });
}

function minutesBetween(
  startedAt: string | null,
  completedAt: string | null,
): number {
  if (!startedAt || !completedAt) return 0;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const diffMs = end - start;
  if (diffMs <= 0) return 0;
  return diffMs / 60_000;
}

function round6(n: number): number {
  return +n.toFixed(6);
}

function round3(n: number): number {
  return +n.toFixed(3);
}

// silence unused imports under strict mode
void and;
void desc;
void toIso;
