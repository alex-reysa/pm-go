import { ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type {
  CompletionAuditReport,
  FinalReleaseWorkflowInput,
  FinalReleaseWorkflowResult,
  UUID,
} from "@pm-go/contracts";
import {
  retryPolicyFor,
  temporalRetryFromConfig,
} from "@pm-go/temporal-workflows";

interface FinalReleaseActivityInterface {
  loadCompletionAuditReport(
    id: UUID,
  ): Promise<CompletionAuditReport | null>;
  persistCompletionEvidenceBundle(input: {
    planId: UUID;
    completionAuditReportId: UUID;
  }): Promise<{ artifactId: UUID; uri: string }>;
  renderAndPersistPrSummary(input: {
    planId: UUID;
    completionAuditReportId: UUID;
  }): Promise<{ artifactId: UUID; uri: string }>;
}

const {
  loadCompletionAuditReport,
  persistCompletionEvidenceBundle,
  renderAndPersistPrSummary,
} = proxyActivities<FinalReleaseActivityInterface>({
  startToCloseTimeout: "5 minutes",
  retry: temporalRetryFromConfig(retryPolicyFor("FinalReleaseWorkflow")),
});

/**
 * FinalReleaseWorkflow — produce PR-ready artifacts from a passing
 * completion audit. V1 scope per `mvp-boundaries.md`: markdown PR
 * summary + JSON evidence bundle; no `gh pr create`.
 *
 * The evidence bundle is persisted BEFORE the PR summary so the
 * summary's traceability section can cite the bundle's artifact id.
 */
export async function FinalReleaseWorkflow(
  input: FinalReleaseWorkflowInput,
): Promise<FinalReleaseWorkflowResult> {
  const audit = await loadCompletionAuditReport(input.completionAuditReportId);
  if (!audit) {
    throw new Error(
      `FinalReleaseWorkflow: completion audit ${input.completionAuditReportId} not found`,
    );
  }
  if (audit.outcome !== "pass") {
    throw ApplicationFailure.nonRetryable(
      `FinalReleaseWorkflow: completion audit ${audit.id} has outcome '${audit.outcome}'; release requires 'pass'`,
      "ReleaseGateClosed",
    );
  }

  const bundle = await persistCompletionEvidenceBundle({
    planId: input.planId,
    completionAuditReportId: input.completionAuditReportId,
  });
  const prSummary = await renderAndPersistPrSummary({
    planId: input.planId,
    completionAuditReportId: input.completionAuditReportId,
  });

  return {
    planId: input.planId,
    completionAuditReportId: input.completionAuditReportId,
    sourceOfTruthArtifactId: bundle.artifactId,
    outputArtifactIds: [prSummary.artifactId],
  };
}
