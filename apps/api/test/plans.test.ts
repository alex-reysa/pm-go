import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";

import type { Plan, Task, Phase } from "@pm-go/contracts";

import { createApp } from "../src/app.js";

// Load a canonical Plan fixture off disk. Using the same fixture the
// planner stub returns keeps the GET round-trip test shape-identical to
// what the end-to-end smoke persists.
const planFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));

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
 * Build a minimal select/from/where/limit chain that returns the given
 * row sequence across successive `select(...)` invocations. drizzle's
 * chain terminates at `.where(...)` for multi-row queries and at
 * `.limit(n)` for single-row lookups, so the chain exposes both.
 */
function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    const whereThenable: Promise<unknown[]> & {
      limit?: (n: number) => Promise<unknown[]>;
    } = Object.assign(Promise.resolve(rows), {
      limit: (_n: number) => Promise.resolve(rows),
    });
    const where = vi.fn().mockImplementation(() => whereThenable);
    const from = vi.fn().mockImplementation(() => ({ where }));
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

function planToRows(plan: Plan) {
  const planRow = {
    id: plan.id,
    specDocumentId: plan.specDocumentId,
    repoSnapshotId: plan.repoSnapshotId,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    risks: plan.risks,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  const phaseRows = plan.phases.map((p: Phase) => ({
    id: p.id,
    planId: p.planId,
    index: p.index,
    title: p.title,
    summary: p.summary,
    status: p.status,
    integrationBranch: p.integrationBranch,
    baseSnapshotId: p.baseSnapshotId,
    taskIdsOrdered: p.taskIds,
    mergeOrder: p.mergeOrder,
    phaseAuditReportId: p.phaseAuditReportId ?? null,
    startedAt: p.startedAt ?? null,
    completedAt: p.completedAt ?? null,
  }));
  const taskRows = plan.tasks.map((t: Task) => ({
    id: t.id,
    planId: t.planId,
    phaseId: t.phaseId,
    slug: t.slug,
    title: t.title,
    summary: t.summary,
    kind: t.kind,
    status: t.status,
    riskLevel: t.riskLevel,
    fileScope: t.fileScope,
    acceptanceCriteria: t.acceptanceCriteria,
    testCommands: t.testCommands,
    budget: t.budget,
    reviewerPolicy: t.reviewerPolicy,
    requiresHumanApproval: t.requiresHumanApproval,
    maxReviewFixCycles: t.maxReviewFixCycles,
    branchName: t.branchName ?? null,
    worktreePath: t.worktreePath ?? null,
  }));
  const edgeRows = plan.phases.flatMap((p) =>
    p.dependencyEdges.map((e) => ({
      fromTaskId: e.fromTaskId,
      toTaskId: e.toTaskId,
      reason: e.reason,
      required: e.required,
    })),
  );
  return { planRow, phaseRows, taskRows, edgeRows };
}

describe("POST /plans", () => {
  it("starts the workflow and returns 202 with planId === specDocumentId", async () => {
    const { start, client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      artifactDir: "./artifacts/plans",
    });

    const specId = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const snapshotId = "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00";

    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specDocumentId: specId,
        repoSnapshotId: snapshotId,
      }),
    });

    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      planId: string;
      workflowRunId: string;
    };
    expect(payload.planId).toBe(specId);
    expect(payload.workflowRunId).toBe("run-xyz");

    expect(start).toHaveBeenCalledWith(
      "SpecToPlanWorkflow",
      expect.objectContaining({
        taskQueue: "pm-go-worker",
        workflowId: `plan-${specId}`,
        args: [
          {
            specDocumentId: specId,
            repoSnapshotId: snapshotId,
            requestedBy: "api",
          },
        ],
      }),
    );
  });

  it("returns 400 when specDocumentId is not a UUID", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      artifactDir: "./artifacts/plans",
    });

    const res = await app.request("/plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        specDocumentId: "not-a-uuid",
        repoSnapshotId: "f0e1d2c3-b4a5-4768-99aa-bbccddeeff00",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /plans/:planId/audit", () => {
  it("returns 404 when the plan row does not exist", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[], [], []]);

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
    });

    const res = await app.request(
      "/plans/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d/audit",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with audit outcome when the plan exists", async () => {
    const { client } = makeMockTemporal();
    const { planRow, phaseRows, taskRows, edgeRows } = planToRows(planFixture);
    // 4 successive selects: plans, phases, plan_tasks, task_dependencies.
    const db = makeMockDbForLookup([[planRow], phaseRows, taskRows, edgeRows]);

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
    });

    const res = await app.request(`/plans/${planFixture.id}/audit`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      planId: string;
      approved: boolean;
      revisionRequested: boolean;
      findings: unknown[];
    };
    expect(payload.planId).toBe(planFixture.id);
    expect(typeof payload.approved).toBe("boolean");
    expect(Array.isArray(payload.findings)).toBe(true);
  });
});

describe("GET /plans/:planId", () => {
  it("returns 404 when the plan does not exist", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
    });

    const res = await app.request(
      "/plans/a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with the reconstructed plan + artifactIds", async () => {
    const { client } = makeMockTemporal();
    const { planRow, phaseRows, taskRows, edgeRows } = planToRows(planFixture);
    const artifactRows = [{ id: "11111111-2222-4333-8444-aaaaaaaaaaaa" }];
    // 5 selects: plans, phases, plan_tasks, task_dependencies, artifacts.
    const db = makeMockDbForLookup([
      [planRow],
      phaseRows,
      taskRows,
      edgeRows,
      artifactRows,
    ]);

    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      db,
      artifactDir: "./artifacts/plans",
    });

    const res = await app.request(`/plans/${planFixture.id}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      plan: Plan;
      artifactIds: string[];
    };
    expect(payload.plan.id).toBe(planFixture.id);
    expect(payload.plan.phases).toHaveLength(planFixture.phases.length);
    expect(payload.plan.tasks).toHaveLength(planFixture.tasks.length);
    expect(payload.artifactIds).toEqual([
      "11111111-2222-4333-8444-aaaaaaaaaaaa",
    ]);
  });

  it("returns 400 on non-UUID planId", async () => {
    const { client } = makeMockTemporal();
    const app = createApp({
      temporal: client,
      taskQueue: "pm-go-worker",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      artifactDir: "./artifacts/plans",
    });
    const res = await app.request("/plans/not-a-uuid");
    expect(res.status).toBe(400);
  });
});
