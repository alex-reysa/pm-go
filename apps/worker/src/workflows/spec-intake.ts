import { proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  Artifact,
  Plan,
  ReviewFinding,
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

/**
 * The workflow sandbox forbids dynamic I/O imports — `@pm-go/db`,
 * `@pm-go/repo-intelligence`, and the Claude Agent SDK must stay out.
 * Everything non-deterministic hides behind the activity interface below.
 */
interface SpecToPlanActivities {
  generatePlan(input: {
    specDocumentId: string;
    repoSnapshotId: string;
    requestedBy: string;
  }): Promise<{ plan: Plan; agentRun: AgentRun }>;
  auditPlanActivity(plan: Plan): Promise<{
    planId: string;
    approved: boolean;
    revisionRequested: boolean;
    findings: ReviewFinding[];
  }>;
  persistAgentRun(run: AgentRun): Promise<string>;
  persistPlan(plan: Plan): Promise<{
    planId: string;
    phaseCount: number;
    taskCount: number;
  }>;
  renderPlanMarkdownActivity(input: {
    planId: string;
    plan: Plan;
  }): Promise<{ artifact: Artifact }>;
  persistArtifact(artifact: Artifact): Promise<string>;
}

// Cap retries explicitly. Temporal's default is infinite exponential
// backoff, which on a transient-looking-but-actually-fatal activity
// failure (e.g. Anthropic returning "Credit balance is too low") will
// retry until the workflow times out 5+ minutes later. Three attempts
// with bounded backoff fails fast enough to surface real problems while
// still tolerating brief connection blips.
// `generatePlan` is the Opus planning call. Real specs (>10 KB) regularly
// take 8-15 minutes; with retries the previous 5-minute proxy budget hit
// the workflow ceiling. Give it a 30-minute window of its own. Cheap I/O
// activities keep the tight 5-minute budget so a stuck DB write fails fast.
const { generatePlan } = proxyActivities<SpecToPlanActivities>({
  startToCloseTimeout: "30 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("SpecToPlanWorkflow")),
});

const {
  auditPlanActivity,
  persistAgentRun,
  persistPlan,
  renderPlanMarkdownActivity,
  persistArtifact,
} = proxyActivities<SpecToPlanActivities>({
  startToCloseTimeout: "5 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("SpecToPlanWorkflow")),
});

/**
 * Spec-to-plan orchestration:
 * 1. Run the planner (`generatePlan`) to obtain a Plan + AgentRun.
 * 2. Persist the AgentRun (planner telemetry).
 * 3. Audit the Plan deterministically; stamp the Plan status based on the
 *    audit outcome (`approved` -> `"approved"`, otherwise `"blocked"`).
 * 4. Persist the (stamped) Plan.
 * 5. Only if approved, render + persist the Markdown artifact.
 */
export async function SpecToPlanWorkflow(
  input: SpecToPlanWorkflowInput,
): Promise<SpecToPlanWorkflowResult> {
  const { plan, agentRun } = await generatePlan({
    specDocumentId: input.specDocumentId,
    repoSnapshotId: input.repoSnapshotId,
    requestedBy: input.requestedBy,
  });

  await persistAgentRun(agentRun);

  const auditResult = await auditPlanActivity(plan);
  const planToPersist: Plan = {
    ...plan,
    status: auditResult.approved ? "approved" : "blocked",
  };

  await persistPlan(planToPersist);

  if (!auditResult.approved) {
    return { plan: planToPersist };
  }

  const { artifact } = await renderPlanMarkdownActivity({
    planId: planToPersist.id,
    plan: planToPersist,
  });
  await persistArtifact(artifact);

  return {
    plan: planToPersist,
    renderedPlanArtifactId: artifact.id,
  };
}
