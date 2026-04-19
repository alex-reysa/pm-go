import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  CompletionAuditReport,
  CompletionAuditWorkflowInput,
  CompletionAuditWorkflowResult,
  Phase,
  PhaseAuditReport,
  Plan,
  UUID,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

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
} = proxyActivities<CompletionAuditActivityInterface>({
  startToCloseTimeout: "45 minutes",
  retry: {
    maximumAttempts: 3,
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
  },
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

  return {
    planId: input.planId,
    report: auditor.report,
    readyForRelease: auditor.report.outcome === "pass",
  };
}
