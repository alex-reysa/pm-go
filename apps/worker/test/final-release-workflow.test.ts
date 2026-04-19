import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionAuditReport } from "@pm-go/contracts";

const activityFns = {
  loadCompletionAuditReport: vi.fn(),
  persistCompletionEvidenceBundle: vi.fn(),
  renderAndPersistPrSummary: vi.fn(),
};

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => activityFns,
  uuid4: () => "mock-uuid",
  ApplicationFailure: {
    nonRetryable: (message: string, type: string) => {
      const err = new Error(message) as Error & {
        type: string;
        nonRetryable: true;
      };
      err.type = type;
      err.nonRetryable = true;
      return err;
    },
  },
}));

const { FinalReleaseWorkflow } = await import(
  "../src/workflows/final-release.js"
);

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const REPORT_ID = "22222222-2222-4222-8222-222222222222";
const BUNDLE_ID = "33333333-3333-4333-8333-333333333333";
const SUMMARY_ID = "44444444-4444-4444-8444-444444444444";

function makeAudit(outcome: "pass" | "changes_requested"): CompletionAuditReport {
  return {
    id: REPORT_ID,
    planId: PLAN_ID,
    finalPhaseId: "phase-final",
    mergeRunId: "mr-1",
    auditorRunId: "ar-1",
    auditedHeadSha: "b".repeat(40),
    outcome,
    checklist: [],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: [],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: "2026-04-19T00:20:00.000Z",
  };
}

describe("FinalReleaseWorkflow", () => {
  beforeEach(() => {
    for (const fn of Object.values(activityFns)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  it("persists evidence bundle BEFORE PR summary so summary can cite bundle", async () => {
    activityFns.loadCompletionAuditReport.mockResolvedValue(makeAudit("pass"));
    const callOrder: string[] = [];
    activityFns.persistCompletionEvidenceBundle.mockImplementation(async () => {
      callOrder.push("bundle");
      return { artifactId: BUNDLE_ID, uri: "file:///bundle.json" };
    });
    activityFns.renderAndPersistPrSummary.mockImplementation(async () => {
      callOrder.push("summary");
      return { artifactId: SUMMARY_ID, uri: "file:///summary.md" };
    });

    const result = await FinalReleaseWorkflow({
      planId: PLAN_ID,
      completionAuditReportId: REPORT_ID,
    });

    expect(callOrder).toEqual(["bundle", "summary"]);
    expect(result.sourceOfTruthArtifactId).toBe(BUNDLE_ID);
    expect(result.outputArtifactIds).toEqual([SUMMARY_ID]);
    expect(result.pullRequestUrl).toBeUndefined();
  });

  it("refuses to run when completion audit is not passing (nonRetryable)", async () => {
    activityFns.loadCompletionAuditReport.mockResolvedValue(
      makeAudit("changes_requested"),
    );

    await expect(
      FinalReleaseWorkflow({
        planId: PLAN_ID,
        completionAuditReportId: REPORT_ID,
      }),
    ).rejects.toMatchObject({
      type: "ReleaseGateClosed",
      nonRetryable: true,
    });

    expect(activityFns.persistCompletionEvidenceBundle).not.toHaveBeenCalled();
    expect(activityFns.renderAndPersistPrSummary).not.toHaveBeenCalled();
  });

  it("throws a plain Error when the audit id is missing", async () => {
    activityFns.loadCompletionAuditReport.mockResolvedValue(null);

    await expect(
      FinalReleaseWorkflow({
        planId: PLAN_ID,
        completionAuditReportId: REPORT_ID,
      }),
    ).rejects.toThrow(/not found/);
  });
});
