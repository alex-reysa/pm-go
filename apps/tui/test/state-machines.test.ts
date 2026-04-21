import { describe, expect, it } from "vitest";

import type {
  CompletionAuditReport,
  Phase,
  Plan,
  Task,
  UUID,
} from "@pm-go/contracts";

import type { PlanDetail } from "../src/lib/api.js";
import {
  canAuditPhase,
  canCompletePlan,
  canFixTask,
  canIntegratePhase,
  canReleasePlan,
  canReviewTask,
  canRunTask,
} from "../src/lib/state-machines.js";

const UUID1 = "00000000-0000-0000-0000-000000000001";
const UUID2 = "00000000-0000-0000-0000-000000000002";

function makePhase(overrides: Partial<Phase> = {}): Phase {
  return {
    id: UUID1,
    planId: UUID2,
    index: 0,
    title: "Phase",
    summary: "",
    status: "pending",
    integrationBranch: "integration/0",
    baseSnapshotId: UUID2,
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: UUID2,
    planId: UUID1,
    phaseId: UUID1,
    slug: "t-1",
    title: "Task",
    summary: "",
    kind: "implementation",
    status: "pending",
    riskLevel: "low",
    fileScope: { includes: ["src/"] },
    acceptanceCriteria: [],
    testCommands: [],
    budget: { maxWallClockMinutes: 30 },
    reviewerPolicy: {
      required: true,
      strictness: "standard",
      maxCycles: 2,
      reviewerWriteAccess: false,
      stopOnHighSeverityCount: 1,
    },
    requiresHumanApproval: false,
    maxReviewFixCycles: 2,
    ...overrides,
  };
}

function makePlan(phases: Phase[], tasks: Task[] = []): Plan {
  return {
    id: UUID1,
    specDocumentId: UUID1,
    repoSnapshotId: UUID2,
    title: "Plan",
    summary: "",
    status: "approved",
    phases,
    tasks,
    risks: [],
    createdAt: "2026-04-21T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeAudit(outcome: CompletionAuditReport["outcome"]): CompletionAuditReport {
  return {
    id: UUID1,
    planId: UUID1,
    finalPhaseId: UUID2,
    mergeRunId: UUID1,
    auditorRunId: UUID2,
    auditedHeadSha: "abc123",
    outcome,
    checklist: [],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: [],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: "2026-04-21T00:00:00.000Z",
  };
}

function makeDetail(
  plan: Plan,
  audit: CompletionAuditReport | null = null,
  artifactIds: UUID[] = [],
): PlanDetail {
  return { plan, artifactIds, latestCompletionAudit: audit };
}

describe("canRunTask", () => {
  it("ok when phase is executing and task is runnable", () => {
    expect(
      canRunTask(makePhase({ status: "executing" }), makeTask({ status: "pending" })).ok,
    ).toBe(true);
  });

  it("blocks when phase is not executing", () => {
    const result = canRunTask(makePhase({ status: "pending" }), makeTask());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'pending'");
  });

  it("blocks when task is already merged/ready_to_merge", () => {
    expect(
      canRunTask(makePhase({ status: "executing" }), makeTask({ status: "merged" })).ok,
    ).toBe(false);
  });
});

describe("canReviewTask", () => {
  it("ok when task is in_review", () => {
    expect(canReviewTask(makeTask({ status: "in_review" })).ok).toBe(true);
  });

  it("blocks on other statuses", () => {
    expect(canReviewTask(makeTask({ status: "running" })).ok).toBe(false);
  });
});

describe("canFixTask", () => {
  it("ok when status is fixing", () => {
    expect(canFixTask(makeTask({ status: "fixing" })).ok).toBe(true);
  });

  it("blocks when status is anything else", () => {
    expect(canFixTask(makeTask({ status: "in_review" })).ok).toBe(false);
  });
});

describe("canIntegratePhase", () => {
  it("ok when phase executing and all tasks ready_to_merge", () => {
    const phase = makePhase({ status: "executing" });
    const tasks = [
      makeTask({ id: "a", status: "ready_to_merge" }),
      makeTask({ id: "b", status: "merged" }),
    ];
    expect(canIntegratePhase(phase, tasks).ok).toBe(true);
  });

  it("blocks when phase is auditing", () => {
    expect(canIntegratePhase(makePhase({ status: "auditing" }), []).ok).toBe(false);
  });

  it("blocks when any task is not ready", () => {
    const phase = makePhase({ status: "executing" });
    const tasks = [makeTask({ status: "running" })];
    const result = canIntegratePhase(phase, tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("1 task");
  });
});

describe("canAuditPhase", () => {
  it("ok when phase is auditing", () => {
    expect(canAuditPhase(makePhase({ status: "auditing" })).ok).toBe(true);
  });

  it("blocks otherwise", () => {
    expect(canAuditPhase(makePhase({ status: "completed" })).ok).toBe(false);
  });
});

describe("canCompletePlan", () => {
  it("ok when every phase is completed", () => {
    const plan = makePlan([
      makePhase({ id: "p0", status: "completed" }),
      makePhase({ id: "p1", status: "completed" }),
    ]);
    expect(canCompletePlan(plan).ok).toBe(true);
  });

  it("blocks when any phase isn't completed", () => {
    const plan = makePlan([
      makePhase({ id: "p0", status: "completed" }),
      makePhase({ id: "p1", status: "executing" }),
    ]);
    const result = canCompletePlan(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("1 phase");
  });

  it("blocks when plan has no phases", () => {
    expect(canCompletePlan(makePlan([])).ok).toBe(false);
  });
});

describe("canReleasePlan", () => {
  it("ok when completion audit passed", () => {
    const plan = makePlan([]);
    const detail = makeDetail(plan, makeAudit("pass"));
    expect(canReleasePlan(detail).ok).toBe(true);
  });

  it("blocks when no completion audit exists", () => {
    const detail = makeDetail(makePlan([]), null);
    expect(canReleasePlan(detail).ok).toBe(false);
  });

  it("blocks when outcome is not pass", () => {
    const detail = makeDetail(makePlan([]), makeAudit("changes_requested"));
    const result = canReleasePlan(detail);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("changes_requested");
  });
});
