import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRun,
  CompletionAuditReport,
  Phase,
  PhaseAuditReport,
  Plan,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";

const activityFns = {
  loadPlan: vi.fn(),
  loadPhase: vi.fn(),
  loadMergeRun: vi.fn(),
  loadPlanPhaseAudits: vi.fn(),
  runCompletionAuditor: vi.fn(),
  persistAgentRun: vi.fn(),
  persistCompletionAuditReport: vi.fn(),
  stampPlanCompletionAudit: vi.fn(),
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

const { CompletionAuditWorkflow } = await import(
  "../src/workflows/completion-audit.js"
);

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";
const PHASE_ID_2 = "22222222-2222-4222-8222-222222222223";
const MERGE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const REPORT_ID = "55555555-5555-4555-8555-555555555555";

function makePlan(phases: Phase[]): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: "s1",
    repoSnapshotId: "r1",
    title: "p",
    summary: "s",
    status: "executing",
    phases,
    tasks: [],
    risks: [],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function makePhase(id: string, index: number): Phase {
  return {
    id,
    planId: PLAN_ID,
    index,
    title: `Phase ${index}`,
    summary: "",
    status: "completed",
    integrationBranch: `integration/p/phase-${index}`,
    baseSnapshotId: `base-${index}`,
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

function makeMergeRun(): StoredMergeRun {
  return {
    id: MERGE_RUN_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID_2,
    integrationBranch: "integration/p/phase-1",
    baseSha: "a".repeat(40),
    mergedTaskIds: [],
    integrationHeadSha: "b".repeat(40),
    integrationLeaseId: "lease-1",
    startedAt: "2026-04-19T00:00:00.000Z",
    completedAt: "2026-04-19T00:05:00.000Z",
  };
}

function makePhaseAudit(phaseId: string, outcome: "pass" | "blocked"): PhaseAuditReport {
  return {
    id: `audit-${phaseId}`,
    phaseId,
    planId: PLAN_ID,
    mergeRunId: MERGE_RUN_ID,
    auditorRunId: "auditor-x",
    mergedHeadSha: "c".repeat(40),
    outcome,
    checklist: [],
    findings: [],
    summary: "s",
    createdAt: "2026-04-19T00:10:00.000Z",
  };
}

function makeCompletionReport(outcome: "pass" | "changes_requested"): CompletionAuditReport {
  return {
    id: REPORT_ID,
    planId: PLAN_ID,
    finalPhaseId: PHASE_ID_2,
    mergeRunId: MERGE_RUN_ID,
    auditorRunId: "completion-auditor-1",
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

function makeAgentRun(): AgentRun {
  return {
    id: "completion-auditor-1",
    workflowRunId: "wf-1",
    role: "auditor",
    depth: 2,
    status: "completed",
    riskLevel: "low",
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "completion-auditor@1",
    permissionMode: "default",
    startedAt: "2026-04-19T00:19:00.000Z",
    completedAt: "2026-04-19T00:20:00.000Z",
  };
}

describe("CompletionAuditWorkflow", () => {
  beforeEach(() => {
    for (const fn of Object.values(activityFns)) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  it("stamps plan completed on pass", async () => {
    const phases = [makePhase(PHASE_ID, 0), makePhase(PHASE_ID_2, 1)];
    activityFns.loadPlan.mockResolvedValue(makePlan(phases));
    activityFns.loadPhase.mockResolvedValue(phases[1]!);
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlanPhaseAudits.mockResolvedValue([
      makePhaseAudit(PHASE_ID, "pass"),
      makePhaseAudit(PHASE_ID_2, "pass"),
    ]);
    activityFns.runCompletionAuditor.mockResolvedValue({
      report: makeCompletionReport("pass"),
      agentRun: makeAgentRun(),
    });

    const result = await CompletionAuditWorkflow({
      planId: PLAN_ID,
      finalPhaseId: PHASE_ID_2,
      mergeRunId: MERGE_RUN_ID,
      requestedBy: "test",
    });

    expect(result.readyForRelease).toBe(true);
    expect(activityFns.stampPlanCompletionAudit).toHaveBeenCalledWith({
      planId: PLAN_ID,
      reportId: REPORT_ID,
      planStatus: "completed",
    });
  });

  it("stamps plan blocked on changes_requested", async () => {
    const phases = [makePhase(PHASE_ID, 0), makePhase(PHASE_ID_2, 1)];
    activityFns.loadPlan.mockResolvedValue(makePlan(phases));
    activityFns.loadPhase.mockResolvedValue(phases[1]!);
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlanPhaseAudits.mockResolvedValue([
      makePhaseAudit(PHASE_ID, "pass"),
      makePhaseAudit(PHASE_ID_2, "pass"),
    ]);
    activityFns.runCompletionAuditor.mockResolvedValue({
      report: makeCompletionReport("changes_requested"),
      agentRun: makeAgentRun(),
    });

    const result = await CompletionAuditWorkflow({
      planId: PLAN_ID,
      finalPhaseId: PHASE_ID_2,
      mergeRunId: MERGE_RUN_ID,
      requestedBy: "test",
    });

    expect(result.readyForRelease).toBe(false);
    expect(activityFns.stampPlanCompletionAudit).toHaveBeenCalledWith({
      planId: PLAN_ID,
      reportId: REPORT_ID,
      planStatus: "blocked",
    });
  });

  it("refuses to run when any phase lacks a pass verdict (nonRetryable)", async () => {
    const phases = [makePhase(PHASE_ID, 0), makePhase(PHASE_ID_2, 1)];
    activityFns.loadPlan.mockResolvedValue(makePlan(phases));
    activityFns.loadPhase.mockResolvedValue(phases[1]!);
    activityFns.loadMergeRun.mockResolvedValue(makeMergeRun());
    activityFns.loadPlanPhaseAudits.mockResolvedValue([
      makePhaseAudit(PHASE_ID, "pass"),
      makePhaseAudit(PHASE_ID_2, "blocked"),
    ]);

    await expect(
      CompletionAuditWorkflow({
        planId: PLAN_ID,
        finalPhaseId: PHASE_ID_2,
        mergeRunId: MERGE_RUN_ID,
        requestedBy: "test",
      }),
    ).rejects.toMatchObject({
      type: "PhaseAuditsNotAllPassed",
      nonRetryable: true,
    });

    expect(activityFns.runCompletionAuditor).not.toHaveBeenCalled();
  });
});
