import { describe, expect, it, vi } from "vitest";

import type {
  PolicyDecision,
  ReviewFinding,
  ReviewReport,
} from "@pm-go/contracts";
import type { StoredReviewReport } from "@pm-go/temporal-activities";
import { createReviewPersistenceActivities } from "../src/activities/review-persistence.js";

type ReviewPersistenceDb = Parameters<
  typeof createReviewPersistenceActivities
>[0]["db"];

const TASK_ID = "11111111-aaaa-4bbb-8ccc-000000000001";
const REPORT_ID = "22222222-aaaa-4bbb-8ccc-000000000002";
const REVIEWER_RUN_ID = "33333333-aaaa-4bbb-8ccc-000000000003";
const POLICY_ID = "44444444-aaaa-4bbb-8ccc-000000000004";

function makeFindings(severity: ReviewFinding["severity"] = "medium"): ReviewFinding[] {
  return [
    {
      id: "f1",
      severity,
      title: "example finding",
      summary: "test",
      filePath: "packages/x/src/a.ts",
      confidence: 0.8,
      suggestedFixDirection: "Example fix direction.",
    },
  ];
}

function makeStoredReport(overrides: Partial<StoredReviewReport> = {}): StoredReviewReport {
  return {
    id: REPORT_ID,
    taskId: TASK_ID,
    reviewerRunId: REVIEWER_RUN_ID,
    outcome: "changes_requested",
    findings: makeFindings(),
    createdAt: "2026-04-19T10:00:00.000Z",
    cycleNumber: 1,
    reviewedBaseSha: "deadbeef",
    reviewedHeadSha: "cafef00d",
    ...overrides,
  };
}

function makePolicyDecision(
  overrides: Partial<PolicyDecision> = {},
): PolicyDecision {
  return {
    id: POLICY_ID,
    subjectType: "review",
    subjectId: REPORT_ID,
    riskLevel: "medium",
    decision: "retry_allowed",
    reason: "cycle_number < maxReviewFixCycles",
    actor: "system",
    createdAt: "2026-04-19T10:00:01.000Z",
    ...overrides,
  };
}

/**
 * Chainable Drizzle mock for the review-persistence surface. Mirrors the
 * pattern in worktree-activities.test.ts: `.insert(...).values(...).onConflictDoNothing(...)`
 * resolves; `.select(...).from(...).where(...).orderBy(...).limit?(...)` resolves to
 * `selectResult` (used for single + multi-row loads). The `max` aggregation goes
 * through the same select chain and reads the first row's `maxCycle` value.
 */
function makeDbMock(options: { selectResult?: unknown[] } = {}) {
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  // select chain: .from(...).where(...) terminates to an array OR chains
  // .orderBy(...) / .limit(...). We make each link resolve to the same
  // Promise so test code can await at any terminal point.
  const selectResult = options.selectResult ?? [];
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
    db: { insert, select } as unknown as ReviewPersistenceDb,
    spies: {
      insert,
      insertValues,
      onConflictDoNothing,
      select,
      from,
      where,
      orderBy,
      limit,
    },
  };
}

describe("createReviewPersistenceActivities.persistReviewReport", () => {
  it("inserts with ON CONFLICT DO NOTHING (idempotent on retry)", async () => {
    const { db, spies } = makeDbMock();
    const activities = createReviewPersistenceActivities({ db });
    const report = makeStoredReport();

    const id = await activities.persistReviewReport(report);

    expect(id).toBe(report.id);
    expect(spies.insert).toHaveBeenCalledTimes(1);
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: report.id,
        taskId: report.taskId,
        reviewerRunId: report.reviewerRunId,
        outcome: report.outcome,
        findings: report.findings,
        cycleNumber: report.cycleNumber,
        reviewedBaseSha: report.reviewedBaseSha,
        reviewedHeadSha: report.reviewedHeadSha,
        createdAt: report.createdAt,
      }),
    );
    expect(spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

describe("createReviewPersistenceActivities.loadLatestReviewReport", () => {
  it("returns the most recent report by createdAt or null when none exist", async () => {
    const { db: emptyDb } = makeDbMock({ selectResult: [] });
    const empty = await createReviewPersistenceActivities({
      db: emptyDb,
    }).loadLatestReviewReport(TASK_ID);
    expect(empty).toBeNull();

    const storedRow = {
      id: REPORT_ID,
      taskId: TASK_ID,
      reviewerRunId: REVIEWER_RUN_ID,
      outcome: "changes_requested" as const,
      findings: makeFindings(),
      cycleNumber: 1,
      reviewedBaseSha: "deadbeef",
      reviewedHeadSha: "cafef00d",
      createdAt: "2026-04-19T10:00:00.000Z",
    };
    const { db } = makeDbMock({ selectResult: [storedRow] });
    const report = await createReviewPersistenceActivities({
      db,
    }).loadLatestReviewReport(TASK_ID);
    expect(report).toEqual({
      id: storedRow.id,
      taskId: storedRow.taskId,
      reviewerRunId: storedRow.reviewerRunId,
      outcome: storedRow.outcome,
      findings: storedRow.findings,
      cycleNumber: storedRow.cycleNumber,
      reviewedBaseSha: storedRow.reviewedBaseSha,
      reviewedHeadSha: storedRow.reviewedHeadSha,
      createdAt: storedRow.createdAt,
    } satisfies ReviewReport & { cycleNumber: number; reviewedBaseSha: string; reviewedHeadSha: string });
  });
});

describe("createReviewPersistenceActivities.countFixCyclesForTask", () => {
  it("returns 0 when no reviews exist", async () => {
    const { db } = makeDbMock({ selectResult: [{ maxCycle: null }] });
    const count = await createReviewPersistenceActivities({
      db,
    }).countFixCyclesForTask(TASK_ID);
    expect(count).toBe(0);
  });

  it("coerces the aggregated value to a number", async () => {
    // pg driver can return numeric aggregates as strings depending on the
    // underlying column; the activity normalizes.
    const { db: numericDb } = makeDbMock({ selectResult: [{ maxCycle: 2 }] });
    expect(
      await createReviewPersistenceActivities({ db: numericDb }).countFixCyclesForTask(
        TASK_ID,
      ),
    ).toBe(2);

    const { db: stringDb } = makeDbMock({ selectResult: [{ maxCycle: "3" }] });
    expect(
      await createReviewPersistenceActivities({ db: stringDb }).countFixCyclesForTask(
        TASK_ID,
      ),
    ).toBe(3);
  });
});

describe("createReviewPersistenceActivities.persistPolicyDecision", () => {
  it("inserts a policy_decisions row with ON CONFLICT DO NOTHING", async () => {
    const { db, spies } = makeDbMock();
    const decision = makePolicyDecision();

    const id = await createReviewPersistenceActivities({
      db,
    }).persistPolicyDecision(decision);

    expect(id).toBe(decision.id);
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: decision.id,
        subjectType: decision.subjectType,
        subjectId: decision.subjectId,
        decision: decision.decision,
        actor: decision.actor,
      }),
    );
    expect(spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});
