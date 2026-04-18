import { proxyActivities } from "@temporalio/workflow";
import type {
  AgentRun,
  Artifact,
  Plan,
  ReviewFinding,
  SpecToPlanWorkflowInput,
  SpecToPlanWorkflowResult,
} from "@pm-go/contracts";

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

const {
  generatePlan,
  auditPlanActivity,
  persistAgentRun,
  persistPlan,
  renderPlanMarkdownActivity,
  persistArtifact,
} = proxyActivities<SpecToPlanActivities>({
  startToCloseTimeout: "5 minutes",
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
