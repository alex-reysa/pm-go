import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  CompletionAuditReport,
  CompletionAuditWorkflowInput,
  CompletionAuditWorkflowResult,
  Phase,
  PhaseAuditReport,
  Plan,
  StopDecision,
  UUID,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

type PlanStatus =
  | "draft"
  | "auditing"
  | "approved"
  | "blocked"
  | "executing"
  | "completed"
  | "failed";

interface CompletionAuditActivityInterface {
  loadPlan(input: { planId: UUID }): Promise<Plan>;
  loadPhase(input: { phaseId: UUID }): Promise<Phase>;
  loadMergeRun(id: UUID): Promise<StoredMergeRun | null>;
  loadPlanPhaseAudits(input: {
    planId: UUID;
  }): Promise<PhaseAuditReport[]>;
  runCompletionAuditor(input: {
    plan: Plan;
    finalPhase: Phase;
    finalMergeRun: StoredMergeRun;
    workflowRunId?: string;
    parentSessionId?: string;
  }): Promise<{ report: CompletionAuditReport; agentRun: AgentRun }>;
  persistAgentRun(run: AgentRun): Promise<UUID>;
  persistCompletionAuditReport(
    report: CompletionAuditReport,
  ): Promise<UUID>;
  stampPlanCompletionAudit(input: {
    planId: UUID;
    reportId: UUID;
    planStatus: PlanStatus;
  }): Promise<void>;
  // Phase 7 — stop-condition gate at the release threshold.
  evaluateStopConditionActivity(input: {
    planId: UUID;
    taskId?: UUID;
  }): Promise<StopDecision>;
  persistBudgetReport(input: { planId: UUID }): Promise<{ id: UUID }>;
}

const {
  loadPlan,
  loadPhase,
  loadMergeRun,
  loadPlanPhaseAudits,
  runCompletionAuditor,
  persistAgentRun,
  persistCompletionAuditReport,
  stampPlanCompletionAudit,
  evaluateStopConditionActivity,
  persistBudgetReport,
} = proxyActivities<CompletionAuditActivityInterface>({
  startToCloseTimeout: "45 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("CompletionAuditWorkflow")),
});

/**
 * CompletionAuditWorkflow — the release gate.
 *
 * Preconditions: every phase must already have `outcome='pass'` on its
 * latest phase audit. If any phase isn't passed, surface the precondition
 * failure as `ApplicationFailure.nonRetryable` so Temporal doesn't burn
 * retries.
 *
 * On pass: `plan.status='completed'`, `plan.completion_audit_report_id`
 * stamped.
 *
 * On changes_requested/blocked: `plan.status='blocked'` (human drives
 * re-audit by re-POSTing `/plans/:id/complete`).
 */
export async function CompletionAuditWorkflow(
  input: CompletionAuditWorkflowInput,
): Promise<CompletionAuditWorkflowResult> {
  const plan = await loadPlan({ planId: input.planId });
  const finalPhase = await loadPhase({ phaseId: input.finalPhaseId });
  const finalMergeRun = await loadMergeRun(input.mergeRunId);
  if (!finalMergeRun) {
    throw new Error(
      `CompletionAuditWorkflow: merge_run ${input.mergeRunId} not found`,
    );
  }

  // Precondition — every phase must have passed its audit. This is the
  // release-gate invariant. Count passed audits against phase count; if
  // any phase has no audit or non-pass outcome, bail non-retryably.
  const phaseAudits = await loadPlanPhaseAudits({ planId: input.planId });
  const passedPhaseIds = new Set(
    phaseAudits.filter((a) => a.outcome === "pass").map((a) => a.phaseId),
  );
  const unpassed = plan.phases.filter((p) => !passedPhaseIds.has(p.id));
  if (unpassed.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `CompletionAuditWorkflow: cannot run — phases without pass verdict: ${unpassed
        .map((p) => `${p.title} (${p.id})`)
        .join(", ")}`,
      "PhaseAuditsNotAllPassed",
    );
  }

  // Phase 7 — stop condition. If the plan has tripped a structural
  // limit (high-severity findings, exhausted phase reruns), bail
  // non-retryably so a re-driven /complete doesn't burn another
  // auditor run on a doomed plan. The decision is best-effort
  // observability — no blocking transition here.
  const stop = await evaluateStopConditionActivity({ planId: input.planId });
  if (stop.stop) {
    throw ApplicationFailure.nonRetryable(
      `CompletionAuditWorkflow: stop_condition_met — ${stop.reason}`,
      "StopConditionMet",
    );
  }

  const auditor = await runCompletionAuditor({
    plan,
    finalPhase,
    finalMergeRun,
  });

  await persistAgentRun(auditor.agentRun);
  await persistCompletionAuditReport(auditor.report);

  const nextPlanStatus: PlanStatus =
    auditor.report.outcome === "pass" ? "completed" : "blocked";

  await stampPlanCompletionAudit({
    planId: input.planId,
    reportId: auditor.report.id,
    planStatus: nextPlanStatus,
  });

  // Phase 7: snapshot the plan-wide budget at the completion-audit
  // checkpoint so /budget-report serves a fresh row even if no
  // integration ran since the last snapshot. Best-effort.
  await persistBudgetReport({ planId: input.planId }).catch(() => undefined);

  return {
    planId: input.planId,
    report: auditor.report,
    readyForRelease: auditor.report.outcome === "pass",
  };
}
