import { describe, expect, it, vi } from "vitest";

// Bug #12 fix: the override-audit handler now calls
// `fastForwardMainViaUpdateRef` from `@pm-go/worktree-manager` to advance
// `refs/heads/main` before any DB mutations, mirroring
// `PhaseAuditWorkflow:142`. Mock the entire module surface so unit tests
// don't shell out to a real git repo. Individual tests below override
// the mock via `fastForwardSpy.mockResolvedValueOnce(...)` /
// `mockRejectedValueOnce(...)` to assert invocation args or simulate FF
// failures.
//
// `vi.mock(...)` is hoisted to the top of the file, so the factory
// can't reference module-scope `const` bindings declared below. Use
// `vi.hoisted(...)` so the spy + error class are created on the same
// hoisted timeline as the mock factory.
const { fastForwardSpy, MockWorktreeManagerError } = vi.hoisted(() => {
  const spy = vi.fn().mockResolvedValue({ headSha: "deadbeef" });
  class WorktreeManagerErrorMock extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "WorktreeManagerError";
      this.code = code;
    }
  }
  return { fastForwardSpy: spy, MockWorktreeManagerError: WorktreeManagerErrorMock };
});
vi.mock("@pm-go/worktree-manager", () => ({
  fastForwardMainViaUpdateRef: fastForwardSpy,
  WorktreeManagerError: MockWorktreeManagerError,
}));

import { createApp } from "../src/app.js";

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-xyz",
    workflowId: "wf-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

/**
 * Chainable mock of drizzle select pipelines. Returns `rowsPerSelect[i]`
 * for the i-th invocation of `.select()`. Every terminal form —
 * `.where`, `.orderBy`, `.orderBy(...).limit(n)`, `.limit(n)` — resolves
 * to the rows so test shapes stay identical regardless of the route's
 * chain depth.
 */
function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    const orderByChain: Promise<unknown[]> & {
      limit?: (n: number) => Promise<unknown[]>;
    } = Object.assign(Promise.resolve(rows), {
      limit: (_n: number) => Promise.resolve(rows),
    });
    const orderBy = vi.fn().mockImplementation(() => orderByChain);
    const whereChain: Promise<unknown[]> & {
      limit?: (n: number) => Promise<unknown[]>;
      orderBy?: typeof orderBy;
    } = Object.assign(Promise.resolve(rows), {
      limit: (_n: number) => Promise.resolve(rows),
      orderBy,
    });
    const where = vi.fn().mockImplementation(() => whereChain);
    const from = vi.fn().mockImplementation(() => ({ where }));
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const PHASE_ID = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PLAN_ID = "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00";
const MERGE_RUN_ID = "11111111-2222-4333-8444-555555555555";

function appWith(
  db: unknown,
  temporal: ReturnType<typeof makeMockTemporal>["client"],
) {
  return createApp({
    temporal,
    taskQueue: "pm-go-worker",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    artifactDir: ".",
    repoRoot: "/",
    worktreeRoot: "/",
    maxLifetimeHours: 24,
  });
}

describe("POST /phases/:phaseId/integrate", () => {
  it("returns 400 on non-UUID phaseId", async () => {
    const { client } = makeMockTemporal();
    const app = appWith(makeMockDbForLookup([]), client);
    const res = await app.request("/phases/not-a-uuid/integrate", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when phase row is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/integrate`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when phase.status is not executing/integrating", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "auditing" }],
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/integrate`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when any in-phase task isn't ready_to_merge/merged", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "executing" }],
      [
        { id: "t1", status: "ready_to_merge" },
        { id: "t2", status: "in_review" },
      ],
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/integrate`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("starts PhaseIntegrationWorkflow with counter-suffix id on happy path", async () => {
    const { client, start } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "executing" }],
      [{ id: "t1", status: "ready_to_merge" }],
      [], // prior merge runs
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/integrate`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledWith(
      "PhaseIntegrationWorkflow",
      expect.objectContaining({
        workflowId: `phase-integrate-${PHASE_ID}-1`,
        args: [{ planId: PLAN_ID, phaseId: PHASE_ID }],
      }),
    );
  });
});

describe("POST /phases/:phaseId/audit", () => {
  it("returns 409 when phase.status isn't auditing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "integrating" }],
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/audit`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("returns 409 when latest merge_run has a failed_task_id", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "auditing" }],
      [
        {
          id: MERGE_RUN_ID,
          failedTaskId: "task-failed",
          integrationHeadSha: "abc",
        },
      ],
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/audit`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });

  it("starts PhaseAuditWorkflow with counter-suffix id on happy path", async () => {
    const { client, start } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, status: "auditing" }],
      [
        {
          id: MERGE_RUN_ID,
          failedTaskId: null,
          integrationHeadSha: "a".repeat(40),
        },
      ],
      [], // prior audits
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/audit`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      phaseId: string;
      mergeRunId: string;
      workflowRunId: string;
      auditIndex: number;
    };
    expect(payload.mergeRunId).toBe(MERGE_RUN_ID);
    expect(payload.auditIndex).toBe(1);
    expect(start).toHaveBeenCalledWith(
      "PhaseAuditWorkflow",
      expect.objectContaining({
        workflowId: `phase-audit-${PHASE_ID}-1`,
      }),
    );
  });
});

describe("GET /phases/:phaseId", () => {
  it("returns 404 when phase row missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}`);
    expect(res.status).toBe(404);
  });

  it("inlines latest merge run + phase audit into the phase response", async () => {
    const { client } = makeMockTemporal();
    const phaseRow = {
      id: PHASE_ID,
      planId: PLAN_ID,
      index: 0,
      title: "Phase 0",
      summary: "",
      status: "auditing",
      integrationBranch: "integration/x/phase-0",
      baseSnapshotId: "snap-0",
      taskIdsOrdered: [],
      mergeOrder: [],
      phaseAuditReportId: null,
      startedAt: null,
      completedAt: null,
    };
    const mergeRunRow = {
      id: MERGE_RUN_ID,
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      integrationBranch: "integration/x/phase-0",
      baseSha: "a".repeat(40),
      mergedTaskIds: ["t1"],
      failedTaskId: null,
      failureReason: null,
      integrationHeadSha: "b".repeat(40),
      postMergeSnapshotId: "snap-1",
      integrationLeaseId: "lease-1",
      startedAt: "2026-04-19T00:00:00.000Z",
      completedAt: "2026-04-19T00:05:00.000Z",
    };
    const db = makeMockDbForLookup([[phaseRow], [mergeRunRow], []]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phase: { id: string };
      latestMergeRun: { id: string; failureReason: string | null } | null;
      latestPhaseAudit: unknown;
    };
    expect(body.phase.id).toBe(PHASE_ID);
    expect(body.latestMergeRun?.id).toBe(MERGE_RUN_ID);
    expect(body.latestMergeRun?.failureReason).toBeNull();
    expect(body.latestPhaseAudit).toBeNull();
  });

  it("exposes merge_run.failureReason on the latest run when set", async () => {
    const { client } = makeMockTemporal();
    const phaseRow = {
      id: PHASE_ID,
      planId: PLAN_ID,
      index: 0,
      title: "Phase 0",
      summary: "",
      status: "blocked",
      integrationBranch: "integration/x/phase-0",
      baseSnapshotId: "snap-0",
      taskIdsOrdered: [],
      mergeOrder: [],
      phaseAuditReportId: null,
      startedAt: null,
      completedAt: null,
    };
    const mergeRunRow = {
      id: MERGE_RUN_ID,
      planId: PLAN_ID,
      phaseId: PHASE_ID,
      integrationBranch: "integration/x/phase-0",
      baseSha: "a".repeat(40),
      mergedTaskIds: [],
      failedTaskId: "11111111-1111-1111-1111-111111111111",
      failureReason: "validation failed for task t1:\n$ pnpm test\nFAILED\nTests 1 failed (1)",
      integrationHeadSha: "b".repeat(40),
      postMergeSnapshotId: null,
      integrationLeaseId: "lease-1",
      startedAt: "2026-04-19T00:00:00.000Z",
      completedAt: "2026-04-19T00:05:00.000Z",
    };
    const db = makeMockDbForLookup([[phaseRow], [mergeRunRow], []]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      latestMergeRun: { failureReason: string | null } | null;
    };
    expect(body.latestMergeRun?.failureReason).toContain("validation failed");
  });
});

describe("GET /phases?planId=", () => {
  it("returns 400 when planId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const app = appWith(makeMockDbForLookup([]), client);
    const res = await app.request("/phases?planId=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns phase summary list ordered by index ascending", async () => {
    const { client } = makeMockTemporal();
    const rows = [
      {
        id: "ph-0",
        planId: PLAN_ID,
        index: 0,
        title: "Phase 0",
        summary: "",
        status: "completed",
        integrationBranch: "integration/x/phase-0",
        phaseAuditReportId: "audit-0",
        startedAt: "2026-04-19T00:00:00.000Z",
        completedAt: "2026-04-19T00:10:00.000Z",
      },
      {
        id: "ph-1",
        planId: PLAN_ID,
        index: 1,
        title: "Phase 1",
        summary: "",
        status: "executing",
        integrationBranch: "integration/x/phase-1",
        phaseAuditReportId: null,
        startedAt: "2026-04-19T00:10:01.000Z",
        completedAt: null,
      },
    ];
    const db = makeMockDbForLookup([rows]);
    const app = appWith(db, client);
    const res = await app.request(`/phases?planId=${PLAN_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planId: string;
      phases: Array<{ id: string; index: number; status: string }>;
    };
    expect(body.planId).toBe(PLAN_ID);
    expect(body.phases.map((p) => p.id)).toEqual(["ph-0", "ph-1"]);
    expect(body.phases[0]!.status).toBe("completed");
  });
});

describe("POST /phases/:phaseId/override-audit (v0.8.2 Task 2.2)", () => {
  it("400s when reason is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("404s when the phase is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "audit FP" }),
    });
    expect(res.status).toBe(404);
  });

  it("409s when the phase is not 'blocked'", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([
      [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "completed" }],
    ]);
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "audit FP" }),
    });
    expect(res.status).toBe(409);
  });

  /**
   * Build a db mock that returns sequential rows for sequential .select()
   * calls. Captures update payloads with the target table key so tests
   * can assert WHICH table got which value, not just the count.
   *
   * After the v0.9.x fix that mirrors PhaseAuditWorkflow's happy path,
   * the override-audit handler does up to FOUR selects on the happy path
   * — (1) phase row, (2) latest audit, (3) next-phase lookup,
   * (4) latest merge_run for snapshot stamping — and up to FOUR updates
   * (phase_audit_reports, phases for the overridden phase, phases for
   * next-phase baseSnapshotId, phases for next-phase status).
   */
  function makeOverrideAuditMockDb(opts: {
    selectsInOrder: unknown[][];
    updateCalls?: Array<{ values: unknown }>;
  }) {
    let selectIdx = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      select: vi.fn().mockImplementation(() => {
        const rows = opts.selectsInOrder[selectIdx++] ?? [];
        const limit = vi.fn().mockResolvedValue(rows);
        const orderBy = vi.fn().mockReturnValue({ limit });
        const where = vi.fn().mockReturnValue({ limit, orderBy });
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      }),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((values: unknown) => {
          opts.updateCalls?.push({ values });
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    return db;
  }

  // Helper merge_run row used by override-audit happy-path tests. Bug
  // #12 fix: the handler now ALWAYS selects the merge_run (right after
  // the audit lookup) so it can pass `integrationHeadSha`+`baseSha` to
  // `fastForwardMainViaUpdateRef`. Refusing to FF main has the same
  // semantics as refusing the override, so the merge_run row must be
  // present in every happy-path fixture.
  const HAPPY_MERGE_RUN = {
    id: MERGE_RUN_ID,
    baseSha: "a".repeat(40),
    integrationHeadSha: "b".repeat(40),
    postMergeSnapshotId: null,
  };

  it("flips a 'blocked' phase to 'completed' when latest audit outcome is 'blocked'", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      // Selects (post-fix order): phase, audit, merge_run, next phase.
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [HAPPY_MERGE_RUN],
        [], // no next phase — this is the last phase
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "operator-accepted blocked audit",
        overriddenBy: "alex",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      newStatus: string;
      reason: string;
      overriddenBy?: string;
      auditReportId: string;
    };
    expect(body.newStatus).toBe("completed");
    expect(body.reason).toContain("operator-accepted");
    expect(body.overriddenBy).toBe("alex");
    expect(body.auditReportId).toBe("audit-1");
    // Two mutations on the last-phase happy path: audit-report stamp +
    // overridden phase -> completed.
    expect(updateCalls.length).toBe(2);
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
  });

  it("flips a 'blocked' phase to 'completed' when latest audit outcome is 'changes_requested'", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "changes_requested" }],
        [HAPPY_MERGE_RUN],
        [], // no next phase
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "ack the findings" }),
    });
    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(2);
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses (409) when no audit report exists (v0.8.2.1 P1.6)", async () => {
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [], // no audit reports — phase is blocked for some other reason
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "force-complete" }),
    });
    expect(res.status).toBe(409);
    expect(updateCalls.length).toBe(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no phase_audit_reports");
  });

  it("refuses (409) when latest audit outcome is 'pass' (v0.8.2.1 P1.6)", async () => {
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "pass" }],
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "force" }),
    });
    expect(res.status).toBe(409);
    expect(updateCalls.length).toBe(0);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("'pass'");
  });

  // Mirror of PhaseAuditWorkflow's happy path (apps/worker/src/workflows/
  // phase-audit.ts:147-167): after the overridden phase is marked
  // `completed`, the next phase (by index+1) must be advanced from
  // `pending` to `executing`, with `base_snapshot_id` stamped from the
  // OVERRIDDEN phase's latest merge_run's `post_merge_snapshot_id`.
  //
  // Bug #12 fix: post-fix update order is (1) audit-report override
  // stamp, (2) next phase baseSnapshotId stamp, (3) next phase ->
  // executing, (4) overridden phase -> completed. The overridden-phase
  // completion moves LAST so the workflow ordering of "advance main +
  // next phase before retiring the current one" is preserved.
  it("advances next pending phase to 'executing' and stamps base_snapshot_id from latest merge_run", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const NEXT_PHASE_ID = "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    const POST_MERGE_SNAPSHOT_ID = "c3d4e5f6-7a8b-4c9d-9e1f-2a3b4c5d6e7f";
    const BASE_SHA = "a".repeat(40);
    const HEAD_SHA = "b".repeat(40);
    const db = makeOverrideAuditMockDb({
      // Selects (post-fix order): phase, audit, merge_run, next phase.
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [
          {
            id: MERGE_RUN_ID,
            baseSha: BASE_SHA,
            integrationHeadSha: HEAD_SHA,
            postMergeSnapshotId: POST_MERGE_SNAPSHOT_ID,
          },
        ],
        [{ id: NEXT_PHASE_ID, status: "pending" }],
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator accepts blocked audit" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phaseId: string;
      newStatus: string;
      nextPhaseId?: string;
      nextPhaseStatus?: string;
    };
    expect(body.newStatus).toBe("completed");
    expect(body.nextPhaseId).toBe(NEXT_PHASE_ID);
    expect(body.nextPhaseStatus).toBe("executing");

    // FF main was called once with the merge_run's head + base shas
    // (mirrors PhaseAuditWorkflow:142).
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
    expect(fastForwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        newSha: HEAD_SHA,
        expectedCurrentSha: BASE_SHA,
      }),
    );

    // 4 updates: phase_audit_reports + next phase baseSnapshotId + next
    // phase status + overridden phase status.
    expect(updateCalls.length).toBe(4);

    // Post-fix order: audit override stamp, next phase baseSnapshotId
    // stamp, next phase -> executing, overridden phase -> completed.
    const nextPhaseSnapshotUpdate = updateCalls[1]!.values as {
      baseSnapshotId: string;
    };
    expect(nextPhaseSnapshotUpdate.baseSnapshotId).toBe(POST_MERGE_SNAPSHOT_ID);

    const nextPhaseStatusUpdate = updateCalls[2]!.values as {
      status: string;
      startedAt: string;
    };
    expect(nextPhaseStatusUpdate.status).toBe("executing");
    expect(typeof nextPhaseStatusUpdate.startedAt).toBe("string");

    const overriddenPhaseUpdate = updateCalls[3]!.values as {
      status: string;
      completedAt: string;
    };
    expect(overriddenPhaseUpdate.status).toBe("completed");
  });

  // Last-phase case: override returns without nextPhaseId fields and
  // does NOT mutate any other phase row.
  it("does not advance any next phase when overriding the last phase", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [HAPPY_MERGE_RUN],
        [], // no row at (planId, index=1) — single-phase plan
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator accepts blocked audit" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      newStatus: string;
      nextPhaseId?: string;
      nextPhaseStatus?: string;
    };
    expect(body.newStatus).toBe("completed");
    expect(body.nextPhaseId).toBeUndefined();
    expect(body.nextPhaseStatus).toBeUndefined();
    // Only audit-report stamp + overridden phase status flip; no
    // updates on any other phase row. FF main still happens — last
    // phase still needs to land on main.
    expect(updateCalls.length).toBe(2);
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
  });

  // Bug #12 acceptance test (a): happy-path fast-forwards `main` to the
  // merge_run's `integration_head_sha` via `fastForwardMainViaUpdateRef`,
  // optimistically locked against `base_sha`. Without this, the override
  // path advances next-phase status without moving main, so the next
  // phase's task worktrees (cut from working HEAD) cannot see Phase N's
  // work.
  it("calls fastForwardMainViaUpdateRef with merge_run's integrationHeadSha + baseSha on happy path (bug #12)", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const BASE_SHA = "1".repeat(40);
    const HEAD_SHA = "2".repeat(40);
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [
          {
            id: MERGE_RUN_ID,
            baseSha: BASE_SHA,
            integrationHeadSha: HEAD_SHA,
            postMergeSnapshotId: null,
          },
        ],
        [], // last phase
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator accepts blocked audit" }),
    });
    expect(res.status).toBe(200);
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
    const [ffArgs] = fastForwardSpy.mock.calls[0]!;
    expect(ffArgs.newSha).toBe(HEAD_SHA);
    expect(ffArgs.expectedCurrentSha).toBe(BASE_SHA);
    expect(typeof ffArgs.repoRoot).toBe("string");
  });

  // Bug #12 acceptance test (b): when `fastForwardMainViaUpdateRef`
  // throws a `WorktreeManagerError` (typically `non-fast-forward` or
  // `main-advance-conflict`), the route must refuse the override with
  // 409, surface the error code, and leave the phase `blocked` without
  // mutating any DB rows. Mirrors `PhaseAuditWorkflow`'s "fail the
  // whole audit if FF errors" semantics.
  it("returns 409 and skips all mutations when FF main fails (bug #12)", async () => {
    fastForwardSpy.mockClear();
    fastForwardSpy.mockRejectedValueOnce(
      new MockWorktreeManagerError(
        "main-advance-conflict",
        "main expected to be at aaa... but is at bbb...",
      ),
    );
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const BASE_SHA = "a".repeat(40);
    const HEAD_SHA = "b".repeat(40);
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [
          {
            id: MERGE_RUN_ID,
            baseSha: BASE_SHA,
            integrationHeadSha: HEAD_SHA,
            postMergeSnapshotId: null,
          },
        ],
        [], // last phase
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator accepts blocked audit" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("main-advance-conflict");
    expect(body.error).toContain("override-audit refused");
    expect(body.error).toContain("main-advance-conflict");
    // No DB mutations: audit row not stamped, phase stays `blocked`.
    expect(updateCalls.length).toBe(0);
    expect(fastForwardSpy).toHaveBeenCalledTimes(1);
  });

  // Bug #12 follow-up: refuse override when no merge_run exists or
  // `integrationHeadSha`/`baseSha` are null. Without these, we cannot
  // FF main, and silently skipping FF would re-introduce the bug.
  it("returns 409 when no merge_run with integrationHeadSha+baseSha exists (bug #12)", async () => {
    fastForwardSpy.mockClear();
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, planId: PLAN_ID, index: 0, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
        [], // no merge_run at all
      ],
      updateCalls,
    });
    const app = appWith(db, client);
    const res = await app.request(`/phases/${PHASE_ID}/override-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator accepts blocked audit" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no merge_run");
    expect(updateCalls.length).toBe(0);
    expect(fastForwardSpy).not.toHaveBeenCalled();
  });
});
