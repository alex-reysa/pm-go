import { describe, expect, it, vi } from "vitest";

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
      latestMergeRun: { id: string } | null;
      latestPhaseAudit: unknown;
    };
    expect(body.phase.id).toBe(PHASE_ID);
    expect(body.latestMergeRun?.id).toBe(MERGE_RUN_ID);
    expect(body.latestPhaseAudit).toBeNull();
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
      [{ id: PHASE_ID, status: "completed" }],
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
   * calls. Captures update payloads. The override-audit handler does
   * exactly two selects (phase row, latest audit) and two updates
   * (phase_audit_reports, phases) on the happy path.
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

  it("flips a 'blocked' phase to 'completed' when latest audit outcome is 'blocked'", async () => {
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, status: "blocked" }],
        [{ id: "audit-1", outcome: "blocked" }],
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
    expect(updateCalls.length).toBe(2);
  });

  it("flips a 'blocked' phase to 'completed' when latest audit outcome is 'changes_requested'", async () => {
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, status: "blocked" }],
        [{ id: "audit-1", outcome: "changes_requested" }],
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
  });

  it("refuses (409) when no audit report exists (v0.8.2.1 P1.6)", async () => {
    const { client } = makeMockTemporal();
    const updateCalls: Array<{ values: unknown }> = [];
    const db = makeOverrideAuditMockDb({
      selectsInOrder: [
        [{ id: PHASE_ID, status: "blocked" }],
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
        [{ id: PHASE_ID, status: "blocked" }],
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
});
