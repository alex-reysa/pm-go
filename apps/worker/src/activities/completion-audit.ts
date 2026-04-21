import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ApplicationFailure } from "@temporalio/activity";
import { and, desc, eq, inArray } from "drizzle-orm";

import type {
  AgentRun,
  CompletionAuditReport,
  DependencyEdge,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
  PolicyDecision,
  Risk,
  StoredReviewReport,
  Task,
  UUID,
} from "@pm-go/contracts";
import {
  artifacts,
  completionAuditReports,
  mergeRuns,
  phaseAuditReports,
  phases,
  planTasks,
  plans,
  policyDecisions,
  repoSnapshots,
  reviewReports,
  taskDependencies,
  workflowEvents,
  worktreeLeases,
  type PmGoDb,
} from "@pm-go/db";
import {
  CompletionAuditValidationError,
  type CompletionAuditorRunner,
} from "@pm-go/executor-claude";
import {
  renderPrSummaryMarkdown,
  runCompletionAuditor as runCompletionAuditorPkg,
} from "@pm-go/planner";
import { createSpanWriter, withSpan } from "@pm-go/observability";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

const execFileAsync = promisify(execFile);

export interface CompletionAuditActivityDeps {
  db: PmGoDb;
  completionAuditorRunner: CompletionAuditorRunner;
  /** Directory into which PR summary + evidence bundle files are written. */
  artifactDir: string;
}

/**
 * Phase 5 completion-audit activities. Wraps the runner with
 * `ApplicationFailure.nonRetryable` translation on validation failure,
 * persists the report idempotently, writes the PR summary + evidence
 * bundle artifacts, and stamps the plan.
 */
export function createCompletionAuditActivities(
  deps: CompletionAuditActivityDeps,
) {
  const { db, completionAuditorRunner, artifactDir } = deps;

  return {
    async runCompletionAuditor(input: {
      plan: Plan;
      finalPhase: Phase;
      finalMergeRun: StoredMergeRun;
      workflowRunId?: string;
      parentSessionId?: string;
    }): Promise<{ report: CompletionAuditReport; agentRun: AgentRun }> {
      // Plan-level base commit = HEAD of plan.repoSnapshotId's snapshot
      // at plan-start. Resolved live here so the activity doesn't pull
      // a stale value from the plan object.
      const [snap] = await db
        .select({ headSha: repoSnapshots.headSha })
        .from(repoSnapshots)
        .where(eq(repoSnapshots.id, input.plan.repoSnapshotId))
        .limit(1);
      if (!snap) {
        throw new Error(
          `runCompletionAuditor: repo_snapshots row ${input.plan.repoSnapshotId} not found`,
        );
      }
      const baseSha = snap.headSha;

      // Final phase's integration worktree path. The lease may be
      // released by the time the completion audit runs; the row still
      // carries the path.
      const worktreePath = await resolveIntegrationWorktreePathForMergeRun(
        db,
        input.finalMergeRun,
      );

      const evidence = await buildCompletionAuditEvidenceImpl(db, {
        planId: input.plan.id,
        finalPhaseId: input.finalPhase.id,
        baseSha,
        worktreePath,
        ...(input.finalMergeRun.integrationHeadSha !== undefined
          ? { integrationHeadSha: input.finalMergeRun.integrationHeadSha }
          : {}),
      });

      try {
        return await runCompletionAuditorPkg({
          plan: input.plan,
          finalPhase: input.finalPhase,
          finalMergeRun: input.finalMergeRun,
          baseSha,
          evidence,
          worktreePath,
          requestedBy: "completion-audit-workflow",
          runner: completionAuditorRunner,
          ...(input.workflowRunId
            ? { workflowRunId: input.workflowRunId }
            : {}),
          ...(input.parentSessionId
            ? { parentSessionId: input.parentSessionId }
            : {}),
        });
      } catch (err) {
        if (err instanceof CompletionAuditValidationError) {
          throw ApplicationFailure.nonRetryable(
            err.message,
            "CompletionAuditValidationError",
          );
        }
        throw err;
      }
    },

    async buildCompletionAuditEvidence(input: {
      planId: UUID;
      finalPhaseId: UUID;
      mergeRunId: UUID;
    }): Promise<{
      phases: Phase[];
      phaseAuditReports: PhaseAuditReport[];
      mergeRuns: MergeRun[];
      reviewReports: StoredReviewReport[];
      policyDecisions: PolicyDecision[];
      diffSummary: string;
    }> {
      // Diagnostic/standalone path — no worktree+head resolution here.
      return buildCompletionAuditEvidenceImpl(db, {
        planId: input.planId,
        finalPhaseId: input.finalPhaseId,
        baseSha: "",
        worktreePath: "",
      });
    },

    async persistCompletionAuditReport(
      report: CompletionAuditReport,
    ): Promise<UUID> {
      const sink = createSpanWriter({ db, planId: report.planId }).writeSpan;
      return withSpan(
        "worker.activities.completion-audit.persistCompletionAuditReport",
        {
          planId: report.planId,
          finalPhaseId: report.finalPhaseId,
          reportId: report.id,
          outcome: report.outcome,
        },
        async () => {
          await db
            .insert(completionAuditReports)
            .values({
              id: report.id,
              planId: report.planId,
              finalPhaseId: report.finalPhaseId,
              mergeRunId: report.mergeRunId,
              auditorRunId: report.auditorRunId,
              auditedHeadSha: report.auditedHeadSha,
              outcome: report.outcome,
              checklist: report.checklist,
              findings: report.findings,
              summary: report.summary,
              createdAt: report.createdAt,
            })
            .onConflictDoNothing({ target: completionAuditReports.id });
          return report.id;
        },
        { sink },
      );
    },

    async loadCompletionAuditReport(
      id: UUID,
    ): Promise<CompletionAuditReport | null> {
      const [row] = await db
        .select()
        .from(completionAuditReports)
        .where(eq(completionAuditReports.id, id))
        .limit(1);
      if (!row) return null;
      return rowToCompletionAuditReport(row);
    },

    /**
     * Transactionally update `plans.completion_audit_report_id` +
     * `plans.status` on a completion audit verdict.
     */
    async stampPlanCompletionAudit(input: {
      planId: UUID;
      reportId: UUID;
      planStatus:
        | "draft"
        | "auditing"
        | "approved"
        | "blocked"
        | "executing"
        | "completed"
        | "failed";
    }): Promise<void> {
      const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;
      await withSpan(
        "worker.activities.completion-audit.stampPlanCompletionAudit",
        {
          planId: input.planId,
          reportId: input.reportId,
          planStatus: input.planStatus,
        },
        async () => {
          await db.transaction(async (tx) => {
            await tx
              .update(plans)
              .set({
                completionAuditReportId: input.reportId,
                status: input.planStatus,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(plans.id, input.planId));
          });
        },
        { sink },
      );
    },

    async renderAndPersistPrSummary(input: {
      planId: UUID;
      completionAuditReportId: UUID;
    }): Promise<{ artifactId: UUID; uri: string }> {
      const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;
      return withSpan(
        "worker.activities.completion-audit.renderAndPersistPrSummary",
        { planId: input.planId, completionAuditReportId: input.completionAuditReportId },
        () => renderAndPersistPrSummaryImpl(db, artifactDir, input),
        { sink },
      );
    },

    async persistCompletionEvidenceBundle(input: {
      planId: UUID;
      completionAuditReportId: UUID;
    }): Promise<{ artifactId: UUID; uri: string }> {
      const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;
      return withSpan(
        "worker.activities.completion-audit.persistCompletionEvidenceBundle",
        { planId: input.planId, completionAuditReportId: input.completionAuditReportId },
        () => persistCompletionEvidenceBundleImpl(db, artifactDir, input),
        { sink },
      );
    },
  };
}

async function renderAndPersistPrSummaryImpl(
  db: PmGoDb,
  artifactDir: string,
  input: { planId: UUID; completionAuditReportId: UUID },
): Promise<{ artifactId: UUID; uri: string }> {
  const plan = await reconstructPlan(db, input.planId);
  if (!plan) {
    throw new Error(
      `renderAndPersistPrSummary: plan ${input.planId} not found`,
    );
  }
  const completionAudit = await loadCompletionAuditReportRow(
    db,
    input.completionAuditReportId,
  );
  if (!completionAudit) {
    throw new Error(
      `renderAndPersistPrSummary: completion audit ${input.completionAuditReportId} not found`,
    );
  }

  const [phaseAuditsRows, mergeRunsRows, evidenceBundleRow] =
    await Promise.all([
      db
        .select()
        .from(phaseAuditReports)
        .where(eq(phaseAuditReports.planId, input.planId)),
      db.select().from(mergeRuns).where(eq(mergeRuns.planId, input.planId)),
      db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.planId, input.planId),
            eq(artifacts.kind, "completion_evidence_bundle"),
          ),
        )
        .orderBy(desc(artifacts.createdAt))
        .limit(1),
    ]);

  const phaseAudits = phaseAuditsRows.map(rowToPhaseAuditReport);
  const mergeRunContracts = mergeRunsRows.map(rowToMergeRun);
  const evidenceBundleId = evidenceBundleRow[0]?.id;

  const md = renderPrSummaryMarkdown(plan, completionAudit, {
    phaseAudits,
    mergeRuns: mergeRunContracts,
    ...(evidenceBundleId !== undefined
      ? { evidenceBundleArtifactId: evidenceBundleId }
      : {}),
  });

  await mkdir(artifactDir, { recursive: true });
  const filePath = path.join(artifactDir, `${input.planId}.pr-summary.md`);
  await writeFile(filePath, md, "utf8");

  const artifactId = randomUUID();
  const uri = pathToFileURL(path.resolve(filePath)).href;
  await db
    .insert(artifacts)
    .values({
      id: artifactId,
      planId: input.planId,
      kind: "pr_summary",
      uri,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: artifacts.id });
  await emitArtifactPersisted(db, {
    planId: input.planId,
    artifactId,
    artifactKind: "pr_summary",
    uri,
  });

  return { artifactId, uri };
}

async function persistCompletionEvidenceBundleImpl(
  db: PmGoDb,
  artifactDir: string,
  input: { planId: UUID; completionAuditReportId: UUID },
): Promise<{ artifactId: UUID; uri: string }> {
  const [phaseAuditsRows, mergeRunsRows, planTaskRows] = await Promise.all([
    db
      .select({ id: phaseAuditReports.id })
      .from(phaseAuditReports)
      .where(eq(phaseAuditReports.planId, input.planId)),
    db
      .select({ id: mergeRuns.id })
      .from(mergeRuns)
      .where(eq(mergeRuns.planId, input.planId)),
    db
      .select({ id: planTasks.id })
      .from(planTasks)
      .where(eq(planTasks.planId, input.planId)),
  ]);

  const taskIds = planTaskRows.map((r) => r.id);
  const [reviewRows, policyRows] = await Promise.all([
    taskIds.length > 0
      ? db
          .select({ id: reviewReports.id })
          .from(reviewReports)
          .where(inArray(reviewReports.taskId, taskIds))
      : Promise.resolve([] as { id: UUID }[]),
    taskIds.length > 0
      ? db
          .select({ id: policyDecisions.id })
          .from(policyDecisions)
          .where(inArray(policyDecisions.subjectId, taskIds))
      : Promise.resolve([] as { id: UUID }[]),
  ]);

  const bundle = {
    planId: input.planId,
    completionAuditReportId: input.completionAuditReportId,
    phaseAuditReportIds: phaseAuditsRows.map((r) => r.id),
    mergeRunIds: mergeRunsRows.map((r) => r.id),
    reviewReportIds: reviewRows.map((r) => r.id),
    policyDecisionIds: policyRows.map((r) => r.id),
  };

  await mkdir(artifactDir, { recursive: true });
  const filePath = path.join(
    artifactDir,
    `${input.planId}.evidence-bundle.json`,
  );
  await writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const artifactId = randomUUID();
  const uri = pathToFileURL(path.resolve(filePath)).href;
  await db
    .insert(artifacts)
    .values({
      id: artifactId,
      planId: input.planId,
      kind: "completion_evidence_bundle",
      uri,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: artifacts.id });
  await emitArtifactPersisted(db, {
    planId: input.planId,
    artifactId,
    artifactKind: "completion_evidence_bundle",
    uri,
  });

  return { artifactId, uri };
}

/**
 * Best-effort emit of an `artifact_persisted` event. Pulled into a
 * module-level helper so the two artifact-write activities share
 * one call shape. A failed insert logs and returns; the caller
 * already has the artifact row committed and must not fail over
 * a read-model projection.
 */
async function emitArtifactPersisted(
  db: PmGoDb,
  input: {
    planId: UUID;
    artifactId: UUID;
    artifactKind:
      | "plan_markdown"
      | "review_report"
      | "completion_audit_report"
      | "completion_evidence_bundle"
      | "test_report"
      | "event_log"
      | "patch_bundle"
      | "pr_summary";
    uri: string;
  },
): Promise<void> {
  try {
    await db.insert(workflowEvents).values({
      id: randomUUID(),
      planId: input.planId,
      phaseId: null,
      taskId: null,
      kind: "artifact_persisted",
      payload: {
        artifactId: input.artifactId,
        artifactKind: input.artifactKind,
        uri: input.uri,
      },
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      `[events] artifact_persisted emit failed (artifactId=${input.artifactId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers — shared with other activities / workflows
// ---------------------------------------------------------------------------

async function resolveIntegrationWorktreePathForMergeRun(
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
      `resolveIntegrationWorktreePathForMergeRun: no integration lease for merge_run ${mergeRun.id}`,
    );
  }
  return lease.worktreePath;
}

async function buildCompletionAuditEvidenceImpl(
  db: PmGoDb,
  input: {
    planId: UUID;
    finalPhaseId: UUID;
    baseSha: string;
    integrationHeadSha?: string;
    worktreePath: string;
  },
): Promise<{
  phases: Phase[];
  phaseAuditReports: PhaseAuditReport[];
  mergeRuns: MergeRun[];
  reviewReports: StoredReviewReport[];
  policyDecisions: PolicyDecision[];
  diffSummary: string;
}> {
  const [phaseRows, phaseAuditRows, mergeRunRows, taskRows] = await Promise.all(
    [
      db.select().from(phases).where(eq(phases.planId, input.planId)),
      db
        .select()
        .from(phaseAuditReports)
        .where(eq(phaseAuditReports.planId, input.planId)),
      db.select().from(mergeRuns).where(eq(mergeRuns.planId, input.planId)),
      db.select().from(planTasks).where(eq(planTasks.planId, input.planId)),
    ],
  );

  const taskIdsForPlan = taskRows.map((r) => r.id);
  const edgeRows =
    taskIdsForPlan.length > 0
      ? await db
          .select()
          .from(taskDependencies)
          .where(inArray(taskDependencies.fromTaskId, taskIdsForPlan))
      : [];

  const taskIdToPhase = new Map<string, string>();
  for (const t of taskRows) taskIdToPhase.set(t.id, t.phaseId);
  const edgesByPhase = new Map<string, DependencyEdge[]>();
  for (const e of edgeRows) {
    const pid = taskIdToPhase.get(e.fromTaskId);
    if (!pid) continue;
    const list = edgesByPhase.get(pid) ?? [];
    list.push({
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      reason: e.reason,
      required: e.required,
    });
    edgesByPhase.set(pid, list);
  }

  const phasesOut: Phase[] = phaseRows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      id: row.id,
      planId: row.planId,
      index: row.index,
      title: row.title,
      summary: row.summary,
      status: row.status,
      integrationBranch: row.integrationBranch,
      baseSnapshotId: row.baseSnapshotId,
      taskIds: row.taskIdsOrdered,
      dependencyEdges: edgesByPhase.get(row.id) ?? [],
      mergeOrder: row.mergeOrder,
      ...(row.phaseAuditReportId !== null
        ? { phaseAuditReportId: row.phaseAuditReportId }
        : {}),
      ...(row.startedAt !== null ? { startedAt: toIso(row.startedAt) } : {}),
      ...(row.completedAt !== null
        ? { completedAt: toIso(row.completedAt) }
        : {}),
    }));

  const phaseAuditReportsOut = phaseAuditRows.map(rowToPhaseAuditReport);
  const mergeRunsOut = mergeRunRows.map(rowToMergeRun);

  const taskIds = taskRows.map((r) => r.id);
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

  const reviewIds = reviewReportsOut.map((r) => r.id);
  const policyRows =
    reviewIds.length > 0
      ? await db
          .select()
          .from(policyDecisions)
          .where(
            and(
              eq(policyDecisions.subjectType, "review"),
              inArray(policyDecisions.subjectId, reviewIds),
            ),
          )
      : [];
  const policyDecisionsOut: PolicyDecision[] = policyRows.map((r) => ({
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    riskLevel: r.riskLevel,
    decision: r.decision,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.createdAt,
  }));

  const diffSummary =
    input.worktreePath && input.integrationHeadSha && input.baseSha
      ? await captureDiffSummary(
          input.worktreePath,
          input.baseSha,
          input.integrationHeadSha,
        )
      : "";

  return {
    phases: phasesOut,
    phaseAuditReports: phaseAuditReportsOut,
    mergeRuns: mergeRunsOut,
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
      [
        "-C",
        worktreePath,
        "diff",
        "--stat",
        "--name-only",
        `${baseSha}..${headSha}`,
      ],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

async function reconstructPlan(
  db: PmGoDb,
  planId: UUID,
): Promise<Plan | null> {
  const planRows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  const planRow = planRows[0];
  if (!planRow) return null;

  const [phaseRows, taskRows] = await Promise.all([
    db.select().from(phases).where(eq(phases.planId, planId)),
    db.select().from(planTasks).where(eq(planTasks.planId, planId)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const edgeRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(taskDependencies)
          .where(inArray(taskDependencies.fromTaskId, taskIds))
      : [];

  const taskIdToPhase = new Map<string, string>();
  for (const t of taskRows) taskIdToPhase.set(t.id, t.phaseId);
  const edgesByPhase = new Map<string, DependencyEdge[]>();
  for (const e of edgeRows) {
    const pid = taskIdToPhase.get(e.fromTaskId);
    if (!pid) continue;
    const list = edgesByPhase.get(pid) ?? [];
    list.push({
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      reason: e.reason,
      required: e.required,
    });
    edgesByPhase.set(pid, list);
  }

  const phasesOut: Phase[] = phaseRows
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((row) => ({
      id: row.id,
      planId: row.planId,
      index: row.index,
      title: row.title,
      summary: row.summary,
      status: row.status,
      integrationBranch: row.integrationBranch,
      baseSnapshotId: row.baseSnapshotId,
      taskIds: row.taskIdsOrdered,
      dependencyEdges: edgesByPhase.get(row.id) ?? [],
      mergeOrder: row.mergeOrder,
      ...(row.phaseAuditReportId !== null
        ? { phaseAuditReportId: row.phaseAuditReportId }
        : {}),
      ...(row.startedAt !== null ? { startedAt: toIso(row.startedAt) } : {}),
      ...(row.completedAt !== null
        ? { completedAt: toIso(row.completedAt) }
        : {}),
    }));

  const tasksOut: Task[] = taskRows.map((row) => ({
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    kind: row.kind,
    status: row.status,
    riskLevel: row.riskLevel,
    fileScope: row.fileScope,
    acceptanceCriteria: row.acceptanceCriteria,
    testCommands: row.testCommands,
    budget: row.budget,
    reviewerPolicy: row.reviewerPolicy,
    requiresHumanApproval: row.requiresHumanApproval,
    maxReviewFixCycles: row.maxReviewFixCycles,
    ...(row.branchName !== null ? { branchName: row.branchName } : {}),
    ...(row.worktreePath !== null ? { worktreePath: row.worktreePath } : {}),
  }));

  return {
    id: planRow.id,
    specDocumentId: planRow.specDocumentId,
    repoSnapshotId: planRow.repoSnapshotId,
    title: planRow.title,
    summary: planRow.summary,
    status: planRow.status,
    phases: phasesOut,
    tasks: tasksOut,
    risks: (planRow.risks ?? []) as Risk[],
    createdAt: toIso(planRow.createdAt),
    updatedAt: toIso(planRow.updatedAt),
  };
}

async function loadCompletionAuditReportRow(
  db: PmGoDb,
  id: UUID,
): Promise<CompletionAuditReport | null> {
  const [row] = await db
    .select()
    .from(completionAuditReports)
    .where(eq(completionAuditReports.id, id))
    .limit(1);
  if (!row) return null;
  return rowToCompletionAuditReport(row);
}

function rowToCompletionAuditReport(
  row: typeof completionAuditReports.$inferSelect,
): CompletionAuditReport {
  return {
    id: row.id,
    planId: row.planId,
    finalPhaseId: row.finalPhaseId,
    mergeRunId: row.mergeRunId,
    auditorRunId: row.auditorRunId,
    auditedHeadSha: row.auditedHeadSha,
    outcome: row.outcome,
    checklist: row.checklist,
    findings: row.findings,
    summary: row.summary,
    createdAt: row.createdAt,
  };
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

function rowToMergeRun(row: typeof mergeRuns.$inferSelect): MergeRun {
  return {
    id: row.id,
    planId: row.planId,
    phaseId: row.phaseId,
    integrationBranch: row.integrationBranch,
    baseSha: row.baseSha,
    mergedTaskIds: row.mergedTaskIds,
    ...(row.failedTaskId !== null ? { failedTaskId: row.failedTaskId } : {}),
    ...(row.integrationHeadSha !== null
      ? { integrationHeadSha: row.integrationHeadSha }
      : {}),
    startedAt: toIso(row.startedAt),
    ...(row.completedAt !== null
      ? { completedAt: toIso(row.completedAt) }
      : {}),
  };
}

function toIso(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString();
}

export { buildCompletionAuditEvidenceImpl };
