import { describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

import type {
  AgentRun,
  Phase,
  PhaseAuditReport,
  Plan,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";
import {
  PhaseAuditValidationError,
  type PhaseAuditorRunner,
} from "@pm-go/executor-claude";

import { createPhaseAuditActivities } from "../src/activities/phase-audit.js";

type Db = Parameters<typeof createPhaseAuditActivities>[0]["db"];

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";
const MERGE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ID = "44444444-4444-4444-8444-444444444444";
const REPORT_ID = "55555555-5555-4555-8555-555555555555";
const AUDITOR_RUN_ID = "66666666-6666-4666-8666-666666666666";

function makeMergeRun(
  overrides: Partial<StoredMergeRun> = {},
): StoredMergeRun {
  return {
    id: MERGE_RUN_ID,
    planId: PLAN_ID,
    phaseId: PHASE_ID,
    integrationBranch: `integration/${PLAN_ID}/phase-0`,
    baseSha: "a".repeat(40),
    mergedTaskIds: [],
    integrationHeadSha: "b".repeat(40),
    integrationLeaseId: LEASE_ID,
    startedAt: "2026-04-19T00:00:00.000Z",
    completedAt: "2026-04-19T00:10:00.000Z",
    ...overrides,
  };
}

function makePlan(): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repoSnapshotId: "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Test plan",
    summary: "summary",
    status: "executing",
    phases: [],
    tasks: [],
    risks: [],
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function makePhase(): Phase {
  return {
    id: PHASE_ID,
    planId: PLAN_ID,
    index: 0,
    title: "Phase 0",
    summary: "phase summary",
    status: "auditing",
    integrationBranch: `integration/${PLAN_ID}/phase-0`,
    baseSnapshotId: "cccc3333-cccc-4ccc-8ccc-cccccccccccc",
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

function makeAgentRun(): AgentRun {
  return {
    id: AUDITOR_RUN_ID,
    workflowRunId: "wf-1",
    role: "auditor",
    depth: 2,
    status: "completed",
    riskLevel: "low",
    executor: "claude",
    model: "claude-sonnet-4-6",
    promptVersion: "phase-auditor@1",
    permissionMode: "default",
    startedAt: "2026-04-19T00:00:00.000Z",
    completedAt: "2026-04-19T00:00:01.000Z",
  };
}

function makeReport(): PhaseAuditReport {
  return {
    id: REPORT_ID,
    phaseId: PHASE_ID,
    planId: PLAN_ID,
    mergeRunId: MERGE_RUN_ID,
    auditorRunId: AUDITOR_RUN_ID,
    mergedHeadSha: "b".repeat(40),
    outcome: "pass",
    checklist: [],
    findings: [],
    summary: "all good",
    createdAt: "2026-04-19T00:00:02.000Z",
  };
}

/**
 * Chainable Drizzle mock. `.select(...).from(...).where(...).limit(N)` resolves
 * to `selectResult`; `.insert(...).values(...).onConflictDoNothing(...)`
 * resolves. Each chain link is thenable so `await` at any point works.
 */
function makeDbMock(selectResult: unknown[] = []) {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const limit = vi.fn().mockResolvedValue(selectResult);
  const orderByThenable = {
    then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
    limit,
  };
  const orderBy = vi.fn().mockReturnValue(orderByThenable);
  const whereThenable = {
    then: (resolve: (v: unknown[]) => void) => resolve(selectResult),
    orderBy,
    limit,
  };
  const where = vi.fn().mockReturnValue(whereThenable);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return {
    db: { insert, select } as unknown as Db,
    spies: { insert, insertValues, onConflictDoNothing, select, where, limit },
  };
}

function makeRunnerThrowing(err: unknown): PhaseAuditorRunner {
  return {
    run: vi.fn().mockRejectedValue(err),
  };
}

function makeRunnerReturning(
  report: PhaseAuditReport,
  agentRun: AgentRun,
): PhaseAuditorRunner {
  return {
    run: vi.fn().mockResolvedValue({ report, agentRun }),
  };
}

describe("createPhaseAuditActivities.runPhaseAuditor", () => {
  it("translates PhaseAuditValidationError into ApplicationFailure.nonRetryable", async () => {
    // Mock: first select resolves the integration worktree path from lease,
    // subsequent selects during evidence assembly return empty arrays.
    const leaseRow = { worktreePath: "/tmp/worktree" };
    const { db } = makeDbMock([leaseRow]);
    const runner = makeRunnerThrowing(
      new PhaseAuditValidationError("bad schema"),
    );

    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });

    await expect(
      activities.runPhaseAuditor({
        plan: makePlan(),
        phase: makePhase(),
        mergeRun: makeMergeRun(),
      }),
    ).rejects.toMatchObject({
      type: "PhaseAuditValidationError",
      nonRetryable: true,
    });
  });

  it("rethrows non-validation errors unchanged (Temporal default retry applies)", async () => {
    const { db } = makeDbMock([{ worktreePath: "/tmp/worktree" }]);
    const networkErr = new Error("ECONNRESET");
    const runner = makeRunnerThrowing(networkErr);

    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });

    await expect(
      activities.runPhaseAuditor({
        plan: makePlan(),
        phase: makePhase(),
        mergeRun: makeMergeRun(),
      }),
    ).rejects.toBe(networkErr);
  });

  it("throws clearly when no integration lease is resolvable", async () => {
    // Mock returns no lease either by id or by phase fallback.
    const { db } = makeDbMock([]);
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());

    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });

    await expect(
      activities.runPhaseAuditor({
        plan: makePlan(),
        phase: makePhase(),
        mergeRun: makeMergeRun({ integrationLeaseId: undefined }),
      }),
    ).rejects.toThrow(/no integration lease/);
  });

  it("never throws ApplicationFailure.nonRetryable on generic Error", async () => {
    // Important: only PhaseAuditValidationError translates. Everything else
    // must remain retryable so Temporal's default policy applies.
    const { db } = makeDbMock([{ worktreePath: "/tmp/worktree" }]);
    const runner = makeRunnerThrowing(new TypeError("boom"));
    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });

    try {
      await activities.runPhaseAuditor({
        plan: makePlan(),
        phase: makePhase(),
        mergeRun: makeMergeRun(),
      });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(ApplicationFailure);
    }
  });
});

describe("createPhaseAuditActivities.persistPhaseAuditReport", () => {
  it("inserts with ON CONFLICT DO NOTHING", async () => {
    const { db, spies } = makeDbMock();
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });
    const report = makeReport();

    const id = await activities.persistPhaseAuditReport(report);

    expect(id).toBe(report.id);
    // Phase 7: withSpan emits a `span_emitted` row on the same insert
    // primitive. The phase_audit_reports row is the first call; the
    // span row is the second. Assert the original write happened by
    // checking the call args, not the count.
    expect(spies.insert).toHaveBeenCalled();
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: report.id,
        phaseId: report.phaseId,
        mergeRunId: report.mergeRunId,
        outcome: report.outcome,
      }),
    );
    expect(spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

describe("createPhaseAuditActivities.loadLatestPhaseAuditForPhase", () => {
  it("returns null when no rows exist", async () => {
    const { db } = makeDbMock([]);
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });
    const out = await activities.loadLatestPhaseAuditForPhase(PHASE_ID);
    expect(out).toBeNull();
  });

  it("returns the latest row when rows are present", async () => {
    const report = makeReport();
    const { db } = makeDbMock([report]);
    const runner = makeRunnerReturning(report, makeAgentRun());
    const activities = createPhaseAuditActivities({
      db,
      phaseAuditorRunner: runner,
    });
    const out = await activities.loadLatestPhaseAuditForPhase(PHASE_ID);
    expect(out).toMatchObject({ id: report.id, outcome: report.outcome });
  });
});
