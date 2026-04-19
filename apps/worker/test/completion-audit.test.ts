import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";

import type {
  AgentRun,
  CompletionAuditReport,
  Phase,
  Plan,
} from "@pm-go/contracts";
import type { StoredMergeRun } from "@pm-go/temporal-activities";
import {
  CompletionAuditValidationError,
  type CompletionAuditorRunner,
} from "@pm-go/executor-claude";

import { createCompletionAuditActivities } from "../src/activities/completion-audit.js";

type Db = Parameters<typeof createCompletionAuditActivities>[0]["db"];

const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PHASE_ID = "22222222-2222-4222-8222-222222222222";
const MERGE_RUN_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ID = "44444444-4444-4444-8444-444444444444";
const REPORT_ID = "55555555-5555-4555-8555-555555555555";
const AUDITOR_RUN_ID = "66666666-6666-4666-8666-666666666666";
const REPO_SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";

function makePlan(): Plan {
  return {
    id: PLAN_ID,
    specDocumentId: "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repoSnapshotId: REPO_SNAPSHOT_ID,
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
    status: "completed",
    integrationBranch: `integration/${PLAN_ID}/phase-0`,
    baseSnapshotId: "cccc3333-cccc-4ccc-8ccc-cccccccccccc",
    taskIds: [],
    dependencyEdges: [],
    mergeOrder: [],
  };
}

function makeMergeRun(): StoredMergeRun {
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
    promptVersion: "completion-auditor@1",
    permissionMode: "default",
    startedAt: "2026-04-19T00:00:00.000Z",
    completedAt: "2026-04-19T00:00:01.000Z",
  };
}

function makeReport(): CompletionAuditReport {
  return {
    id: REPORT_ID,
    planId: PLAN_ID,
    finalPhaseId: PHASE_ID,
    mergeRunId: MERGE_RUN_ID,
    auditorRunId: AUDITOR_RUN_ID,
    auditedHeadSha: "b".repeat(40),
    outcome: "pass",
    checklist: [],
    findings: [],
    summary: {
      acceptanceCriteriaPassed: ["ac-1"],
      acceptanceCriteriaMissing: [],
      openFindingIds: [],
      unresolvedPolicyDecisionIds: [],
    },
    createdAt: "2026-04-19T00:00:02.000Z",
  };
}

/**
 * Chainable Drizzle mock with a per-call selectResult queue. Each invocation
 * of `.select(...).from(...).where(...).limit(...)` (or terminal await) pops
 * the next row array from the queue. `.insert` values + `.update.set.where`
 * chains resolve.
 */
function makeDbMock(options: { selectSequence?: unknown[][] } = {}) {
  const sequence = options.selectSequence ?? [];
  let callIdx = 0;
  const nextResult = () => {
    // Pull the next queued result; after the sequence is exhausted, default
    // to `[]` rather than repeating the last entry — repeating a row-shape
    // designed for one table breaks downstream mappers for other tables.
    const r = callIdx < sequence.length ? sequence[callIdx]! : [];
    callIdx += 1;
    return r;
  };

  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const buildSelectChain = () => {
    const result = nextResult();
    const limit = vi.fn().mockResolvedValue(result);
    const orderByLimit = vi.fn().mockResolvedValue(result);
    const orderBy = vi.fn().mockReturnValue({
      then: (resolve: (v: unknown) => void) => resolve(result),
      limit: orderByLimit,
    });
    const where = vi.fn().mockReturnValue({
      then: (resolve: (v: unknown) => void) => resolve(result),
      orderBy,
      limit,
    });
    const from = vi.fn().mockReturnValue({ where });
    return { from, where, limit, orderBy };
  };

  const select = vi.fn().mockImplementation(() => {
    const chain = buildSelectChain();
    return { from: chain.from };
  });

  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    return cb({ insert, select, update });
  });

  return {
    db: { insert, select, update, transaction } as unknown as Db,
    spies: {
      insert,
      insertValues,
      onConflictDoNothing,
      select,
      update,
      updateSet,
      updateWhere,
      transaction,
    },
  };
}

function makeRunnerThrowing(err: unknown): CompletionAuditorRunner {
  return { run: vi.fn().mockRejectedValue(err) };
}

function makeRunnerReturning(
  report: CompletionAuditReport,
  agentRun: AgentRun,
): CompletionAuditorRunner {
  return { run: vi.fn().mockResolvedValue({ report, agentRun }) };
}

describe("createCompletionAuditActivities.runCompletionAuditor", () => {
  it("translates CompletionAuditValidationError → ApplicationFailure.nonRetryable", async () => {
    // Sequence: (1) repo_snapshots lookup → [{headSha}], (2) worktree lease
    // lookup → [{worktreePath}], (3+) evidence assembly → [].
    const { db } = makeDbMock({
      selectSequence: [
        [{ headSha: "a".repeat(40) }],
        [{ worktreePath: "/tmp/worktree" }],
      ],
    });
    const runner = makeRunnerThrowing(
      new CompletionAuditValidationError("bad output"),
    );
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: "/tmp/ignored",
    });

    await expect(
      activities.runCompletionAuditor({
        plan: makePlan(),
        finalPhase: makePhase(),
        finalMergeRun: makeMergeRun(),
      }),
    ).rejects.toMatchObject({
      type: "CompletionAuditValidationError",
      nonRetryable: true,
    });
  });

  it("does NOT wrap generic errors in ApplicationFailure", async () => {
    const { db } = makeDbMock({
      selectSequence: [
        [{ headSha: "a".repeat(40) }],
        [{ worktreePath: "/tmp/worktree" }],
      ],
    });
    const err = new Error("network blip");
    const runner = makeRunnerThrowing(err);
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: "/tmp/ignored",
    });

    try {
      await activities.runCompletionAuditor({
        plan: makePlan(),
        finalPhase: makePhase(),
        finalMergeRun: makeMergeRun(),
      });
      throw new Error("expected rejection");
    } catch (caught) {
      expect(caught).toBe(err);
      expect(caught).not.toBeInstanceOf(ApplicationFailure);
    }
  });

  it("throws when plan.repoSnapshotId has no row", async () => {
    // First select (repo_snapshots) returns empty.
    const { db } = makeDbMock({ selectSequence: [[]] });
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: "/tmp/ignored",
    });

    await expect(
      activities.runCompletionAuditor({
        plan: makePlan(),
        finalPhase: makePhase(),
        finalMergeRun: makeMergeRun(),
      }),
    ).rejects.toThrow(/repo_snapshots row .* not found/);
  });
});

describe("createCompletionAuditActivities.persistCompletionAuditReport", () => {
  it("inserts with ON CONFLICT DO NOTHING", async () => {
    const { db, spies } = makeDbMock();
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: "/tmp/ignored",
    });
    const report = makeReport();

    const id = await activities.persistCompletionAuditReport(report);

    expect(id).toBe(report.id);
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: report.id,
        planId: report.planId,
        outcome: report.outcome,
        summary: report.summary,
      }),
    );
    expect(spies.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});

describe("createCompletionAuditActivities.stampPlanCompletionAudit", () => {
  it("runs update inside a transaction", async () => {
    const { db, spies } = makeDbMock();
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: "/tmp/ignored",
    });

    await activities.stampPlanCompletionAudit({
      planId: PLAN_ID,
      reportId: REPORT_ID,
      planStatus: "completed",
    });

    expect(spies.transaction).toHaveBeenCalledTimes(1);
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        completionAuditReportId: REPORT_ID,
        status: "completed",
      }),
    );
  });
});

describe("createCompletionAuditActivities artifact persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "pm-go-completion-audit-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persistCompletionEvidenceBundle writes JSON file + artifact row", async () => {
    // select sequence: phase audits, merge runs, plan tasks, (empty ids so
    // the two inArray selects are skipped).
    const { db, spies } = makeDbMock({
      selectSequence: [
        [{ id: "pa-1" }],
        [{ id: "mr-1" }],
        [{ id: "task-1" }],
        [{ id: "rev-1" }],
        [{ id: "pol-1" }],
      ],
    });
    const runner = makeRunnerReturning(makeReport(), makeAgentRun());
    const activities = createCompletionAuditActivities({
      db,
      completionAuditorRunner: runner,
      artifactDir: tempDir,
    });

    const result = await activities.persistCompletionEvidenceBundle({
      planId: PLAN_ID,
      completionAuditReportId: REPORT_ID,
    });

    expect(result.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.uri).toMatch(/^file:\/\//);

    const filePath = path.join(tempDir, `${PLAN_ID}.evidence-bundle.json`);
    const body = await readFile(filePath, "utf8");
    const parsed = JSON.parse(body);
    expect(parsed.planId).toBe(PLAN_ID);
    expect(parsed.completionAuditReportId).toBe(REPORT_ID);
    expect(parsed.phaseAuditReportIds).toEqual(["pa-1"]);
    expect(parsed.mergeRunIds).toEqual(["mr-1"]);
    expect(parsed.reviewReportIds).toEqual(["rev-1"]);
    expect(parsed.policyDecisionIds).toEqual(["pol-1"]);

    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: PLAN_ID,
        kind: "completion_evidence_bundle",
      }),
    );
  });
});
