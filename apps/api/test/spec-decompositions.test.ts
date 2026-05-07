import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

import type { MilestoneManifest } from "@pm-go/contracts";

import { createApp } from "../src/app.js";

const manifestFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/milestone-manifest.json",
    import.meta.url,
  ),
);
const manifestFixture: MilestoneManifest = JSON.parse(
  readFileSync(manifestFixturePath, "utf8"),
);

const SPEC_ID = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REPO_SNAPSHOT_ID = "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00";
const DECOMPOSITION_ID = "11111111-2222-4333-8444-555555555555";

function manifestForRow(): MilestoneManifest {
  return {
    ...JSON.parse(JSON.stringify(manifestFixture)),
    specDocumentId: SPEC_ID,
    repoSnapshotId: REPO_SNAPSHOT_ID,
  };
}

interface SelectStep {
  rows: unknown[];
}

/**
 * Build a Drizzle-shaped fluent mock that returns row sequences across
 * successive `.select(...)` calls. Mirrors the pattern in plans.test.ts;
 * each call to `select(...)` consumes one entry from `rowsPerSelect`.
 */
function makeMockDb(rowsPerSelect: SelectStep[]): {
  db: unknown;
  selectMock: ReturnType<typeof vi.fn>;
  insertMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  setMock: ReturnType<typeof vi.fn>;
  updateWhereMock: ReturnType<typeof vi.fn>;
  returnedRow: { value: unknown[] };
} {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++]?.rows ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      then: (resolve: (v: unknown[]) => void) => resolve(rows),
    };
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockImplementation(() => chain);
    return { from };
  });

  const valuesMock = vi.fn().mockResolvedValue([]);
  const insertMock = vi
    .fn()
    .mockImplementation(() => ({ values: valuesMock }));

  const returnedRow = { value: [] as unknown[] };
  const returningMock = vi
    .fn()
    .mockImplementation(async () => returnedRow.value);
  const updateWhereMock = vi
    .fn()
    .mockImplementation(() => ({ returning: returningMock }));
  const setMock = vi
    .fn()
    .mockImplementation(() => ({ where: updateWhereMock }));
  const updateMock = vi.fn().mockImplementation(() => ({ set: setMock }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = { select, insert: insertMock, update: updateMock } as any;
  return {
    db,
    selectMock: select,
    insertMock,
    updateMock,
    setMock,
    updateWhereMock,
    returnedRow,
  };
}

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-xyz",
    workflowId: "wf-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

interface BuildAppOptions {
  /**
   * Override what `db.update(...).set(...).where(...).returning(...)`
   * yields. Default is `[]`, which models the "lock already held" /
   * "row vanished" branches. Tests that exercise the happy path set
   * this to a non-empty array (e.g. `[{ id: DECOMPOSITION_ID }]`) so
   * the lock claim succeeds and the route proceeds to
   * `workflow.start`.
   */
  lockReturning?: unknown[];
}

function buildApp(
  rowsPerSelect: SelectStep[],
  options: BuildAppOptions = {},
) {
  const dbBag = makeMockDb(rowsPerSelect);
  if (options.lockReturning !== undefined) {
    dbBag.returnedRow.value = options.lockReturning;
  }
  const tempBag = makeMockTemporal();
  const app = createApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    temporal: tempBag.client as any,
    taskQueue: "pm-go-worker",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: dbBag.db as any,
    artifactDir: "./artifacts/plans",
    repoRoot: "/tmp/repo",
    worktreeRoot: "/tmp/repo/.worktrees",
    maxLifetimeHours: 24,
  });
  return { app, db: dbBag, temporal: tempBag };
}

describe("POST /spec-documents/:id/decompose", () => {
  it("returns 202 with decompositionId after starting the workflow", async () => {
    const { app, temporal } = buildApp([
      { rows: [{ id: SPEC_ID }] }, // spec existence check
      { rows: [{ id: REPO_SNAPSHOT_ID }] }, // repo snapshot existence check
    ]);

    const res = await app.request(`/spec-documents/${SPEC_ID}/decompose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoSnapshotId: REPO_SNAPSHOT_ID }),
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      decompositionId: string;
      workflowRunId: string;
    };
    expect(typeof payload.decompositionId).toBe("string");
    expect(temporal.start).toHaveBeenCalledWith(
      "SpecDecompositionWorkflow",
      expect.objectContaining({ taskQueue: "pm-go-worker" }),
    );
  });

  it("returns 404 when the spec document does not exist", async () => {
    const { app, temporal } = buildApp([{ rows: [] }]);
    const res = await app.request(`/spec-documents/${SPEC_ID}/decompose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoSnapshotId: REPO_SNAPSHOT_ID }),
    });
    expect(res.status).toBe(404);
    expect(temporal.start).not.toHaveBeenCalled();
  });

  it("returns 404 when the repo snapshot does not exist", async () => {
    const { app, temporal } = buildApp([
      { rows: [{ id: SPEC_ID }] }, // spec exists
      { rows: [] }, // snapshot missing
    ]);
    const res = await app.request(`/spec-documents/${SPEC_ID}/decompose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoSnapshotId: REPO_SNAPSHOT_ID }),
    });
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/repo snapshot/);
    expect(temporal.start).not.toHaveBeenCalled();
  });

  it("returns 400 when repoSnapshotId is missing", async () => {
    const { app } = buildApp([]);
    const res = await app.request(`/spec-documents/${SPEC_ID}/decompose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /spec-documents/:id/decompositions/:id", () => {
  it("returns the decomposition row with its manifest", async () => {
    const manifest = manifestForRow();
    const { app } = buildApp([
      {
        rows: [
          {
            id: DECOMPOSITION_ID,
            specDocumentId: SPEC_ID,
            repoSnapshotId: REPO_SNAPSHOT_ID,
            status: "ready",
            manifest,
            errorReason: null,
            planFirstStartedAt: null,
            createdAt: "2026-05-07 10:00:00+00",
            updatedAt: "2026-05-07 10:00:01+00",
          },
        ],
      },
    ]);
    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}`,
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      decomposition: { status: string; manifest: MilestoneManifest };
    };
    expect(payload.decomposition.status).toBe("ready");
    expect(payload.decomposition.manifest).toEqual(manifest);
  });

  it("returns 404 when the decomposition is missing", async () => {
    const { app } = buildApp([{ rows: [] }]);
    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /spec-documents/:id/decompositions/:id/manifest", () => {
  it("returns 409 when a plan already references the decomposition", async () => {
    const manifest = manifestForRow();
    const { app } = buildApp([
      {
        rows: [
          {
            id: DECOMPOSITION_ID,
            specDocumentId: SPEC_ID,
            repoSnapshotId: REPO_SNAPSHOT_ID,
            status: "ready",
            manifest,
            errorReason: null,
            planFirstStartedAt: null,
            createdAt: "2026-05-07 10:00:00+00",
            updatedAt: "2026-05-07 10:00:01+00",
          },
        ],
      },
      // existing plan lookup — non-empty triggers the 409
      { rows: [{ id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }] },
    ]);

    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 when the submitted manifest fails the audit", async () => {
    const broken = manifestForRow();
    // Forward-reference will trip DEPENDENCY_REFERENCES_LATER_MILESTONE.
    broken.milestones[0]!.dependsOn = [broken.milestones[2]!.id];
    const { app } = buildApp([]);
    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest: broken }),
      },
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string; issues?: unknown };
    expect(payload.error).toMatch(/audit/i);
  });
});

describe("POST /spec-documents/:id/decompositions/:id/plan-first", () => {
  it("starts SpecToPlanWorkflow with milestoneContext for milestone[0]", async () => {
    const manifest = manifestForRow();
    const { app, temporal } = buildApp(
      [
        {
          rows: [
            {
              id: DECOMPOSITION_ID,
              specDocumentId: SPEC_ID,
              repoSnapshotId: REPO_SNAPSHOT_ID,
              status: "ready",
              manifest,
              errorReason: null,
              planFirstStartedAt: null,
              createdAt: "2026-05-07 10:00:00+00",
              updatedAt: "2026-05-07 10:00:01+00",
            },
          ],
        },
        // No prior plan for this milestone.
        { rows: [] },
      ],
      // Lock claim succeeds — UPDATE … WHERE plan_first_started_at IS NULL
      // RETURNING id yields the row.
      { lockReturning: [{ id: DECOMPOSITION_ID }] },
    );

    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/plan-first`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      planId: string;
      milestoneId: string;
      decompositionId: string;
    };
    expect(payload.milestoneId).toBe(manifest.milestones[0]!.id);
    expect(payload.decompositionId).toBe(DECOMPOSITION_ID);
    expect(temporal.start).toHaveBeenCalledWith(
      "SpecToPlanWorkflow",
      expect.objectContaining({
        args: [
          expect.objectContaining({
            planId: payload.planId,
            milestoneContext: expect.objectContaining({
              decompositionId: DECOMPOSITION_ID,
              milestoneId: manifest.milestones[0]!.id,
            }),
          }),
        ],
      }),
    );
  });

  it("returns 409 when the decomposition is not ready", async () => {
    const { app, temporal } = buildApp([
      {
        rows: [
          {
            id: DECOMPOSITION_ID,
            specDocumentId: SPEC_ID,
            repoSnapshotId: REPO_SNAPSHOT_ID,
            status: "running",
            manifest: null,
            errorReason: null,
            planFirstStartedAt: null,
            createdAt: "2026-05-07 10:00:00+00",
            updatedAt: "2026-05-07 10:00:01+00",
          },
        ],
      },
    ]);
    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/plan-first`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(409);
    expect(temporal.start).not.toHaveBeenCalled();
  });

  it("returns 409 without starting a workflow when the lock is already held (concurrent plan-first)", async () => {
    const manifest = manifestForRow();
    const { app, temporal } = buildApp(
      [
        {
          rows: [
            {
              id: DECOMPOSITION_ID,
              specDocumentId: SPEC_ID,
              repoSnapshotId: REPO_SNAPSHOT_ID,
              status: "ready",
              manifest,
              errorReason: null,
              planFirstStartedAt: null,
              createdAt: "2026-05-07 10:00:00+00",
              updatedAt: "2026-05-07 10:00:01+00",
            },
          ],
        },
        // No prior plan for this milestone.
        { rows: [] },
      ],
      // Lock claim returns []: another `plan-first` already won the
      // race and stamped `plan_first_started_at`, so the conditional
      // UPDATE matched zero rows.
      { lockReturning: [] },
    );

    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/plan-first`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(409);
    expect(temporal.start).not.toHaveBeenCalled();
  });
});

describe("PUT manifest rejects after plan-first claimed the lock", () => {
  it("returns 409 when planFirstStartedAt is set on the row", async () => {
    const manifest = manifestForRow();
    const { app } = buildApp([
      {
        rows: [
          {
            id: DECOMPOSITION_ID,
            specDocumentId: SPEC_ID,
            repoSnapshotId: REPO_SNAPSHOT_ID,
            status: "ready",
            manifest,
            errorReason: null,
            planFirstStartedAt: "2026-05-07 10:00:05+00",
            createdAt: "2026-05-07 10:00:00+00",
            updatedAt: "2026-05-07 10:00:05+00",
          },
        ],
      },
    ]);

    const res = await app.request(
      `/spec-documents/${SPEC_ID}/decompositions/${DECOMPOSITION_ID}/manifest`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest }),
      },
    );
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toMatch(/plan-first/);
  });
});
