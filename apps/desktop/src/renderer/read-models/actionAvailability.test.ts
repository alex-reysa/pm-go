import { describe, expect, it } from "vitest";

import {
  actionAvailabilityKey,
  buildApprovalActionAvailability,
  buildPhaseActionAvailability,
  buildPlanActionAvailability,
  buildTaskActionAvailability,
} from "./actionAvailability.js";
import type {
  ApprovalRequest,
  PhaseListItem,
  ReleaseReadinessViewModel,
  TaskListItem,
} from "./types.js";

const PLAN_ID = "11111111-2222-4333-8444-555555555555";
const PHASE_ID = "22222222-3333-4444-8555-666666666666";
const TASK_ID = "33333333-4444-4555-8666-777777777777";

function task(overrides: Partial<TaskListItem> = {}): TaskListItem {
  return {
    id: TASK_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    slug: "desktop-action",
    title: "Desktop action",
    status: "pending",
    riskLevel: "medium",
    kind: "implementation",
    ...overrides,
  };
}

function phase(overrides: Partial<PhaseListItem> = {}): PhaseListItem {
  return {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "M4",
    summary: "Operator actions",
    status: "executing",
    integrationBranch: null,
    phaseAuditReportId: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function release(
  state: ReleaseReadinessViewModel["state"],
): ReleaseReadinessViewModel {
  return {
    planId: PLAN_ID,
    state,
    completionAuditOutcome: state === "ready_to_release" ? "pass" : null,
    completionAuditId:
      state === "ready_to_release"
        ? "44444444-5555-4666-8777-888888888888"
        : null,
    releaseArtifactIds: [],
    blockers: [],
    nextAction: state === "ready_to_release" ? "Release plan" : "Run completion audit",
    raw: { events: [] },
    limitations: [],
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "55555555-6666-4777-8888-999999999999",
    planId: PLAN_ID,
    subject: "plan",
    riskBand: "high",
    status: "pending",
    requestedAt: "2026-05-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("M4 action availability", () => {
  it("adds endpoint metadata and scoped pending state to task actions", () => {
    const pendingActionKeys = new Set([
      actionAvailabilityKey("task.overrideReview", TASK_ID),
    ]);
    const actions = buildTaskActionAvailability({
      task: task({ status: "blocked" }),
      phase: phase(),
      approvalStatus: "pending",
      pendingActionKeys,
    });

    expect(actions.find((row) => row.action === "task.run")).toMatchObject({
      subjectType: "task",
      subjectId: TASK_ID,
      method: "POST",
      endpoint: `/tasks/${TASK_ID}/run`,
      requiresReason: false,
    });
    expect(actions.find((row) => row.action === "task.overrideReview")).toMatchObject({
      enabled: true,
      requiresReason: true,
      pending: true,
      endpoint: `/tasks/${TASK_ID}/override-review`,
    });
    expect(actions.find((row) => row.action === "task.approve")).toMatchObject({
      enabled: true,
      endpoint: `/tasks/${TASK_ID}/approve`,
    });
  });

  it("derives phase integration, audit, and override gates from phase state", () => {
    const ready = buildPhaseActionAvailability({
      phase: phase({ status: "executing" }),
      tasks: [
        task({ status: "ready_to_merge" }),
        task({ id: "77777777-8888-4999-9000-aaaaaaaaaaaa", status: "merged" }),
      ],
    });
    expect(ready.find((row) => row.action === "phase.integrate")).toMatchObject({
      enabled: true,
      endpoint: `/phases/${PHASE_ID}/integrate`,
    });

    const unready = buildPhaseActionAvailability({
      phase: phase({ status: "executing" }),
      tasks: [task({ status: "running" })],
    });
    expect(unready.find((row) => row.action === "phase.integrate")).toMatchObject({
      enabled: false,
      reason: "Not every task is ready_to_merge or merged.",
    });

    const blocked = buildPhaseActionAvailability({
      phase: phase({ status: "blocked" }),
      tasks: [task({ status: "merged" })],
    });
    expect(blocked.find((row) => row.action === "phase.overrideAudit")).toMatchObject({
      enabled: true,
      requiresReason: true,
      endpoint: `/phases/${PHASE_ID}/override-audit`,
    });
  });

  it("keeps release disabled until completion audit is ready and bulk approval has a reason gate", () => {
    const blockedRelease = buildPlanActionAvailability({
      planId: PLAN_ID,
      planStatus: "approved",
      phases: [phase({ status: "completed" })],
      release: release("blocked"),
      approvals: [approval()],
    });
    expect(blockedRelease.find((row) => row.action === "plan.release")).toMatchObject({
      enabled: false,
      reason: "Completion audit is not ready for release.",
    });
    expect(blockedRelease.find((row) => row.action === "plan.approveAllPending")).toMatchObject({
      enabled: true,
      requiresReason: true,
      endpoint: `/plans/${PLAN_ID}/approve-all-pending`,
    });

    const readyRelease = buildPlanActionAvailability({
      planId: PLAN_ID,
      planStatus: "completed",
      phases: [phase({ status: "completed" })],
      release: release("ready_to_release"),
      approvals: [],
    });
    expect(readyRelease.find((row) => row.action === "plan.release")).toMatchObject({
      enabled: true,
      endpoint: `/plans/${PLAN_ID}/release`,
    });
  });

  it("maps approval rows back to the subject-specific approve endpoint", () => {
    const planRow = buildApprovalActionAvailability({
      approval: approval({ subject: "plan" }),
    });
    expect(planRow[0]).toMatchObject({
      action: "plan.approve",
      subjectType: "approval",
      subjectId: "55555555-6666-4777-8888-999999999999",
      endpoint: `/plans/${PLAN_ID}/approve`,
      enabled: true,
    });

    const taskRow = buildApprovalActionAvailability({
      approval: approval({
        subject: "task",
        taskId: TASK_ID,
        status: "approved",
      }),
    });
    expect(taskRow[0]).toMatchObject({
      action: "task.approve",
      endpoint: `/tasks/${TASK_ID}/approve`,
      enabled: false,
      reason: "Approval is approved.",
    });
  });
});
