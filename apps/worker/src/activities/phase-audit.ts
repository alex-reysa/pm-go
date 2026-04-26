import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ApplicationFailure } from "@temporalio/activity";
import { and, eq, inArray } from "drizzle-orm";

import type {
  AgentRun,
  Phase,
  PhaseAuditReport,
  Plan,
  PolicyDecision,
  StoredReviewReport,
  Task,
  UUID,
} from "@pm-go/contracts";
import {
  phaseAuditReports,
  planTasks,
  policyDecisions,
  reviewReports,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import {
  PhaseAuditValidationError,
  type PhaseAuditorRunner,
} from "@pm-go/executor-claude";
import { runPhaseAuditor as runPhaseAuditorPkg } from "@pm-go/planner";
import { createSpanWriter, withSpan } from "@pm-go/observability";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

const execFileAsync = promisify(execFile);

export interface PhaseAuditActivityDeps {
  db: PmGoDb;
  phaseAuditorRunner: PhaseAuditorRunner;
  /** Claude model id. When unset, the phase-auditor package default applies. */
  phaseAuditorModel?: string;
}

/**
 * Phase 5 phase-audit activities. Wraps the runner with
 * `ApplicationFailure.nonRetryable` translation so Temporal never
 * retries a malformed model output; assembles the evidence bundle from
 * durable rows; persists the report idempotently.
 */
export function createPhaseAuditActivities(deps: PhaseAuditActivityDeps) {
  const { db, phaseAuditorRunner, phaseAuditorModel } = deps;

  return {
    async runPhaseAuditor(input: {
      plan: Plan;
      phase: Phase;
      mergeRun: StoredMergeRun;
      workflowRunId?: string;
      parentSessionId?: string;
    }): Promise<{ report: PhaseAuditReport; agentRun: AgentRun }> {
      // Resolve the integration worktree path from the mergeRun's lease
      // (set during PhaseIntegrationWorkflow). If the lease was already
      // released (e.g. on a re-audit after release), the path is still
      // in the worktree_leases row even when status='released'.
      const worktreePath = await resolveIntegrationWorktreePath(
        db,
        input.mergeRun,
      );

      // Compute the plan/phase evidence + diffSummary outside the
      // runner call so non-retryable translation only wraps the model
      // invocation.
      const evidence = await buildPhaseAuditEvidenceImpl(db, {
        planId: input.plan.id,
        phaseId: input.phase.id,
        mergeRunId: input.mergeRun.id,
        baseSha: input.mergeRun.baseSha,
        worktreePath,
        ...(input.mergeRun.integrationHeadSha !== undefined
          ? { integrationHeadSha: input.mergeRun.integrationHeadSha }
          : {}),
      });

      try {
        return await runPhaseAuditorPkg({
          plan: input.plan,
          phase: input.phase,
          mergeRun: input.mergeRun,
          baseSha: input.mergeRun.baseSha,
          evidence,
          worktreePath,
          requestedBy: "phase-audit-workflow",
          runner: phaseAuditorRunner,
          ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.parentSessionId
            ? { parentSessionId: input.parentSessionId }
            : {}),
          ...(phaseAuditorModel !== undefined ? { model: phaseAuditorModel } : {}),
        });
      } catch (err) {
        if (err instanceof PhaseAuditValidationError) {
          throw ApplicationFailure.nonRetryable(
            err.message,
            "PhaseAuditValidationError",
          );
        }
        throw err;
      }
    },

    async buildPhaseAuditEvidence(input: {
      planId: UUID;
      phaseId: UUID;
      mergeRunId: UUID;
    }): Promise<{
      tasks: Task[];
      reviewReports: StoredReviewReport[];
      policyDecisions: PolicyDecision[];
      diffSummary: string;
    }> {
      // Standalone diagnostic path: return the bundle without
      // diffSummary. Workflow-invoked callers go through runPhaseAuditor
      // which always has the full context to compute the diff.
      return buildPhaseAuditEvidenceImpl(db, {
        planId: input.planId,
        phaseId: input.phaseId,
        mergeRunId: input.mergeRunId,
        baseSha: "",
        worktreePath: "",
      });
    },

    async persistPhaseAuditReport(report: PhaseAuditReport): Promise<UUID> {
      const sink = createSpanWriter({ db, planId: report.planId }).writeSpan;
      return withSpan(
        "worker.activities.phase-audit.persistPhaseAuditReport",
        {
          planId: report.planId,
          phaseId: report.phaseId,
          reportId: report.id,
          outcome: report.outcome,
        },
        async () => {
          await db
            .insert(phaseAuditReports)
            .values({
              id: report.id,
              phaseId: report.phaseId,
              planId: report.planId,
              mergeRunId: report.mergeRunId,
              auditorRunId: report.auditorRunId,
              mergedHeadSha: report.mergedHeadSha,
              outcome: report.outcome,
              checklist: report.checklist,
              findings: report.findings,
              summary: report.summary,
              createdAt: report.createdAt,
            })
            .onConflictDoNothing({ target: phaseAuditReports.id });
          return report.id;
        },
        { sink },
      );
    },

    async loadLatestPhaseAuditForPhase(
      phaseId: UUID,
    ): Promise<PhaseAuditReport | null> {
      const rows = await db
        .select()
        .from(phaseAuditReports)
        .where(eq(phaseAuditReports.phaseId, phaseId))
        .orderBy(phaseAuditReports.createdAt);
      if (rows.length === 0) return null;
      return rowToPhaseAuditReport(rows[rows.length - 1]!);
    },

    async loadPhaseAuditReport(id: UUID): Promise<PhaseAuditReport | null> {
      const [row] = await db
        .select()
        .from(phaseAuditReports)
        .where(eq(phaseAuditReports.id, id))
        .limit(1);
      if (!row) return null;
      return rowToPhaseAuditReport(row);
    },

    async loadPlanPhaseAudits(input: {
      planId: UUID;
    }): Promise<PhaseAuditReport[]> {
      const rows = await db
        .select()
        .from(phaseAuditReports)
        .where(eq(phaseAuditReports.planId, input.planId));
      return rows.map(rowToPhaseAuditReport);
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence assembly helpers
// ---------------------------------------------------------------------------

async function resolveIntegrationWorktreePath(
  db: PmGoDb,
  mergeRun: StoredMergeRun,
): Promise<string> {
  if (mergeRun.integrationLeaseId) {
    const [lease] = await db
      .select({ worktreePath: worktreeLeases.worktreePath })
      .from(worktreeLeases)
      .where(eq(worktreeLeases.id, mergeRun.integrationLeaseId))
      .limit(1);
    if (lease) return lease.worktreePath;
  }
  // Fallback: any integration lease for the phase (there should be
  // exactly one live at audit time).
  const [lease] = await db
    .select({ worktreePath: worktreeLeases.worktreePath })
    .from(worktreeLeases)
    .where(
      and(
        eq(worktreeLeases.phaseId, mergeRun.phaseId),
        eq(worktreeLeases.kind, "integration"),
      ),
    )
    .limit(1);
  if (!lease) {
    throw new Error(
      `resolveIntegrationWorktreePath: no integration lease for merge_run ${mergeRun.id}`,
    );
  }
  return lease.worktreePath;
}

async function buildPhaseAuditEvidenceImpl(
  db: PmGoDb,
  input: {
    planId: UUID;
    phaseId: UUID;
    mergeRunId: UUID;
    baseSha: string;
    integrationHeadSha?: string;
    worktreePath: string;
  },
): Promise<{
  tasks: Task[];
  reviewReports: StoredReviewReport[];
  policyDecisions: PolicyDecision[];
  diffSummary: string;
}> {
  const taskRows = await db
    .select()
    .from(planTasks)
    .where(eq(planTasks.phaseId, input.phaseId));
  const tasks: Task[] = taskRows.map((r) => ({
    id: r.id,
    planId: r.planId,
    phaseId: r.phaseId,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    kind: r.kind,
    status: r.status,
    riskLevel: r.riskLevel,
    fileScope: r.fileScope,
    acceptanceCriteria: r.acceptanceCriteria,
    testCommands: r.testCommands,
    budget: r.budget,
    reviewerPolicy: r.reviewerPolicy,
    requiresHumanApproval: r.requiresHumanApproval,
    maxReviewFixCycles: r.maxReviewFixCycles,
    ...(r.branchName !== null ? { branchName: r.branchName } : {}),
    ...(r.worktreePath !== null ? { worktreePath: r.worktreePath } : {}),
  }));

  const taskIds = tasks.map((t) => t.id);
  const reviewReportRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(reviewReports)
          .where(inArray(reviewReports.taskId, taskIds))
      : [];
  const reviewReportsOut: StoredReviewReport[] = reviewReportRows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    reviewerRunId: r.reviewerRunId,
    outcome: r.outcome,
    findings: r.findings,
    createdAt: r.createdAt,
    cycleNumber: r.cycleNumber,
    reviewedBaseSha: r.reviewedBaseSha,
    reviewedHeadSha: r.reviewedHeadSha,
  }));

  const reviewReportIds = reviewReportsOut.map((r) => r.id);
  const reviewPolicyDecisionRows =
    reviewReportIds.length > 0
      ? await db
          .select()
          .from(policyDecisions)
          .where(
            and(
              eq(policyDecisions.subjectType, "review"),
              inArray(policyDecisions.subjectId, reviewReportIds),
            ),
          )
      : [];
  // v0.8.2: include task-level policy decisions for tasks in this phase so
  // the auditor sees the small-task fast path's `review_skipped_small_task`
  // approval row alongside the integration-test evidence.
  const taskPolicyDecisionRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(policyDecisions)
          .where(
            and(
              eq(policyDecisions.subjectType, "task"),
              inArray(policyDecisions.subjectId, taskIds),
            ),
          )
      : [];
  const policyDecisionRows = [
    ...reviewPolicyDecisionRows,
    ...taskPolicyDecisionRows,
  ];
  const policyDecisionsOut: PolicyDecision[] = policyDecisionRows.map((r) => ({
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    riskLevel: r.riskLevel,
    decision: r.decision,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.createdAt,
  }));

  // Compute diffSummary only when we have the worktree path + head sha
  // — the standalone `buildPhaseAuditEvidence` activity path doesn't
  // have them and passes empty strings; callers that need the diff
  // should go through `runPhaseAuditor` which always has the full
  // context.
  const diffSummary =
    input.worktreePath && input.integrationHeadSha && input.baseSha
      ? await captureDiffSummary(
          input.worktreePath,
          input.baseSha,
          input.integrationHeadSha,
        )
      : "";

  return {
    tasks,
    reviewReports: reviewReportsOut,
    policyDecisions: policyDecisionsOut,
    diffSummary,
  };
}

async function captureDiffSummary(
  worktreePath: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "diff", "--stat", "--name-only", `${baseSha}..${headSha}`],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

function rowToPhaseAuditReport(
  row: typeof phaseAuditReports.$inferSelect,
): PhaseAuditReport {
  return {
    id: row.id,
    phaseId: row.phaseId,
    planId: row.planId,
    mergeRunId: row.mergeRunId,
    auditorRunId: row.auditorRunId,
    mergedHeadSha: row.mergedHeadSha,
    outcome: row.outcome,
    checklist: row.checklist,
    findings: row.findings,
    summary: row.summary,
    createdAt: row.createdAt,
  };
}

// Export the standalone helper so other activities can reuse it.
export { buildPhaseAuditEvidenceImpl };
export { resolveIntegrationWorktreePath };
