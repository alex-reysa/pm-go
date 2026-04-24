import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

import type {
  AgentRun,
  Artifact,
  Plan,
  SpecDocument,
} from "@pm-go/contracts";
import { createPlanPersistenceActivities } from "../src/activities/plan-persistence.js";

// Resolve fixtures from disk — `@pm-go/contracts` does not re-export JSON
// bodies, mirroring spec-intake.test.ts and packages/db tests.
const planFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const specDocumentFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/spec-document.json",
    import.meta.url,
  ),
);
const agentRunFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/agent-run.json",
    import.meta.url,
  ),
);

const planFixture: Plan = JSON.parse(readFileSync(planFixturePath, "utf8"));
const specDocumentFixture: SpecDocument = JSON.parse(
  readFileSync(specDocumentFixturePath, "utf8"),
);
const agentRunFixture: AgentRun = JSON.parse(
  readFileSync(agentRunFixturePath, "utf8"),
);

// ---------------------------------------------------------------------------
// Mock DB client — a chainable stub for the handful of Drizzle methods the
// activity exercises. Each call pushes onto a shared `calls` log so the test
// can assert ordering, argument shape, and chain-completeness (e.g. that the
// chain actually reaches `.onConflictDoUpdate(...)`).
// ---------------------------------------------------------------------------

interface CallLog {
  insert: Array<{ table: unknown }>;
  values: Array<{ args: unknown }>;
  onConflictDoUpdate: Array<{ args: unknown }>;
  delete: Array<{ table: unknown }>;
  where: Array<{ args: unknown }>;
  select: Array<{ columns?: unknown }>;
  from: Array<{ table: unknown }>;
  limit: Array<{ n: number }>;
  transaction: number;
  update: Array<{ table: unknown; set: unknown; where: unknown }>;
}

function createMockDb(options?: {
  existingDependencyEdges?: Array<{ fromTaskId: string; toTaskId: string }>;
  specDocumentRows?: unknown[];
  repoSnapshotRows?: unknown[];
}) {
  const calls: CallLog = {
    insert: [],
    values: [],
    onConflictDoUpdate: [],
    delete: [],
    where: [],
    select: [],
    from: [],
    limit: [],
    transaction: 0,
    update: [],
  };

  // Builder chain returned by `insert(...)`. `.values().onConflictDoUpdate()`
  // resolves to Promise<void>. `.values().returning()` resolves to rows. We
  // cover both shapes so the chain composes cleanly under `await`.
  const insertChain = () => {
    const onConflict = vi
      .fn()
      .mockImplementation((args: unknown) => {
        calls.onConflictDoUpdate.push({ args });
        return Promise.resolve([]);
      });
    const returning = vi.fn().mockResolvedValue([]);
    const values = vi.fn().mockImplementation((args: unknown) => {
      calls.values.push({ args });
      const promise: Promise<unknown[]> = Promise.resolve([]);
      return Object.assign(promise, {
        onConflictDoUpdate: onConflict,
        returning,
      });
    });
    return { values };
  };

  // Builder chain returned by `delete(...)`. Terminates on `.where(...)`.
  const deleteChain = () => {
    const where = vi.fn().mockImplementation((args: unknown) => {
      calls.where.push({ args });
      return Promise.resolve();
    });
    return { where };
  };

  // Builder chain returned by `update(...)`. `.set().where()` resolves to
  // Promise<void>.
  let pendingUpdateTable: unknown;
  let pendingUpdateSet: unknown;
  const updateChain = (table: unknown) => {
    pendingUpdateTable = table;
    const where = vi.fn().mockImplementation((whereArgs: unknown) => {
      calls.update.push({
        table: pendingUpdateTable,
        set: pendingUpdateSet,
        where: whereArgs,
      });
      return Promise.resolve();
    });
    const set = vi.fn().mockImplementation((setArgs: unknown) => {
      pendingUpdateSet = setArgs;
      return { where };
    });
    return { set };
  };

  // Builder chain returned by `select(...)` (and its select-for-pruning
  // variant). `.from().where()` is itself a thenable that resolves to the
  // stored rows, but it also exposes `.limit(n)` so single-row loaders can
  // terminate the chain explicitly.
  const selectChain = (rowsPromise: Promise<unknown[]>) => {
    const from = vi.fn().mockImplementation((table: unknown) => {
      calls.from.push({ table });
      const where = vi.fn().mockImplementation((args: unknown) => {
        calls.where.push({ args });
        const limit = vi.fn().mockImplementation((n: number) => {
          calls.limit.push({ n });
          return rowsPromise;
        });
        return Object.assign(rowsPromise, { limit });
      });
      return { where };
    });
    return { from };
  };

  // A TX handle forwards to the same chainable stubs so the activity can
  // use either `db.insert(...)` (for agent-runs/artifacts) or `tx.insert(...)`
  // (inside `persistPlan`) with the same semantics.
  const existingEdgeRows: Array<{
    fromTaskId: string;
    toTaskId: string;
  }> = options?.existingDependencyEdges ?? [];

  const tx = {
    insert: vi.fn().mockImplementation((table: unknown) => {
      calls.insert.push({ table });
      return insertChain();
    }),
    delete: vi.fn().mockImplementation((table: unknown) => {
      calls.delete.push({ table });
      return deleteChain();
    }),
    select: vi.fn().mockImplementation((columns?: unknown) => {
      calls.select.push({ columns });
      return selectChain(Promise.resolve(existingEdgeRows));
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      return updateChain(table);
    }),
  };

  const db = {
    transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => {
      calls.transaction += 1;
      return fn(tx);
    }),
    insert: vi.fn().mockImplementation((table: unknown) => {
      calls.insert.push({ table });
      return insertChain();
    }),
    select: vi.fn().mockImplementation((columns?: unknown) => {
      calls.select.push({ columns });
      const rows =
        options?.specDocumentRows ?? options?.repoSnapshotRows ?? [];
      return selectChain(Promise.resolve(rows));
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, tx, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistPlan", () => {
  it("persists the plan fixture inside a single transaction", async () => {
    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    const result = await activities.persistPlan(planFixture);

    // One transaction wraps all writes.
    expect(calls.transaction).toBe(1);

    // 1 plan + N phases + M tasks + K edges inserts (no pre-existing edges
    // in this mock, so no delete calls fire). Phase 7 adds +1 for the
    // span sink that fires after persistPlanImpl returns.
    const edgeCount = planFixture.phases.reduce(
      (n, p) => n + p.dependencyEdges.length,
      0,
    );
    const expectedInserts =
      1 + planFixture.phases.length + planFixture.tasks.length + edgeCount;
    expect(calls.insert).toHaveLength(expectedInserts + 1);

    // Every domain insert chain reaches `.onConflictDoUpdate(...)` — the
    // idempotent shape the spec requires. The span sink does NOT call
    // onConflictDoUpdate so the count stays at expectedInserts.
    expect(calls.onConflictDoUpdate).toHaveLength(expectedInserts);

    // Plan values carry the expected field mapping.
    const planValueCall = calls.values[0]?.args as {
      id: string;
      title: string;
      status: string;
      specDocumentId: string;
    };
    expect(planValueCall).toMatchObject({
      id: planFixture.id,
      title: planFixture.title,
      status: planFixture.status,
      specDocumentId: planFixture.specDocumentId,
    });

    // Returned counts mirror the fixture.
    expect(result).toEqual({
      planId: planFixture.id,
      phaseCount: planFixture.phases.length,
      taskCount: planFixture.tasks.length,
    });
  });

  it("dedupes dependency edges across phases", async () => {
    // Mutate a shallow clone so the base fixture stays clean for other tests.
    const plan: Plan = JSON.parse(JSON.stringify(planFixture));
    const firstEdge = plan.phases[0]!.dependencyEdges[0]!;
    plan.phases[1]!.dependencyEdges.push({ ...firstEdge });

    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistPlan(plan);

    // Only the first occurrence of each (from, to) key survives dedupe.
    const uniqueEdgeKeys = new Set<string>();
    for (const phase of plan.phases) {
      for (const edge of phase.dependencyEdges) {
        uniqueEdgeKeys.add(`${edge.fromTaskId}:${edge.toTaskId}`);
      }
    }
    // Phase 7 adds +1 for the span sink emitted after persistPlanImpl.
    const expectedInserts =
      1 +
      plan.phases.length +
      plan.tasks.length +
      uniqueEdgeKeys.size;
    expect(calls.insert).toHaveLength(expectedInserts + 1);
  });

  it("deletes stale dependency edges that are not in the new edge set", async () => {
    // Seed a stale edge whose from_task_id belongs to the plan but that is
    // absent from the new plan-provided edges. The prune step should remove
    // it with a DELETE before the upserts run.
    const stalePair = {
      fromTaskId: planFixture.tasks[0]!.id,
      toTaskId: "00000000-0000-4000-8000-000000000001",
    };

    const { db, calls } = createMockDb({
      existingDependencyEdges: [stalePair],
    });
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistPlan(planFixture);

    // Exactly one DELETE — for the stale row, not for the live edge that
    // also matches `from_task_id IN (planTaskIds)`.
    expect(calls.delete).toHaveLength(1);
  });

  it("transitions phase-0 from pending to executing when plan status is approved", async () => {
    // Clone the fixture so the base stays clean, then set up the scenario
    // required by ac-f01-04: an 'approved' plan whose first phase is 'pending'.
    const plan: Plan = JSON.parse(JSON.stringify(planFixture));
    plan.status = "approved";
    // Find the phase with index=0 and mark it pending.
    const phase0 = plan.phases.find((p) => p.index === 0);
    expect(phase0).toBeDefined();
    phase0!.status = "pending";

    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistPlan(plan);

    // Exactly one UPDATE should have been issued — for the phase-0 kickoff.
    expect(calls.update).toHaveLength(1);
    const upd = calls.update[0]!;
    // The SET payload must transition the status to 'executing'.
    expect(upd.set).toMatchObject({ status: "executing" });
  });

  it("does NOT update phase-0 when plan status is not approved", async () => {
    const plan: Plan = JSON.parse(JSON.stringify(planFixture));
    // Keep whatever status the fixture has (it should not be 'approved').
    // Ensure it's explicitly not 'approved'.
    plan.status = "in_review";
    const phase0 = plan.phases.find((p) => p.index === 0);
    if (phase0) phase0.status = "pending";

    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistPlan(plan);

    // No UPDATE should fire because the plan is not 'approved'.
    expect(calls.update).toHaveLength(0);
  });

  it("is idempotent — a second call exercises onConflictDoUpdate again", async () => {
    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistPlan(planFixture);
    const firstRound = calls.onConflictDoUpdate.length;
    await activities.persistPlan(planFixture);
    // Each successive call fires the same number of onConflictDoUpdate
    // invocations — the upsert path is taken unconditionally.
    expect(calls.onConflictDoUpdate.length).toBe(firstRound * 2);
    expect(calls.transaction).toBe(2);
  });
});

describe("persistAgentRun", () => {
  it("maps every contract field and returns the id", async () => {
    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    const id = await activities.persistAgentRun(agentRunFixture);

    expect(id).toBe(agentRunFixture.id);
    expect(calls.insert).toHaveLength(1);
    expect(calls.values).toHaveLength(1);
    expect(calls.onConflictDoUpdate).toHaveLength(1);
  });

  it("encodes optional fields as null when absent on the contract", async () => {
    const minimal: AgentRun = {
      id: "0c1d2e3f-4567-4890-a1b2-c3d4e5f60718",
      workflowRunId: "wf-minimal",
      role: "planner",
      depth: 0,
      status: "queued",
      riskLevel: "low",
      executor: "claude",
      model: "claude-sonnet-4-6",
      promptVersion: "planner@1",
      permissionMode: "default",
    };

    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    await activities.persistAgentRun(minimal);

    const args = calls.values[0]?.args as Record<string, unknown>;
    // Every contract-optional column is either null or a required value —
    // never `undefined`, which `exactOptionalPropertyTypes` would flag.
    const nullableKeys = [
      "taskId",
      "sessionId",
      "parentSessionId",
      "budgetUsdCap",
      "maxTurnsCap",
      "turns",
      "inputTokens",
      "outputTokens",
      "cacheCreationTokens",
      "cacheReadTokens",
      "costUsd",
      "stopReason",
      "outputFormatSchemaRef",
      "startedAt",
      "completedAt",
    ] as const;
    for (const key of nullableKeys) {
      expect(args[key]).toBeNull();
    }
  });
});

describe("persistArtifact", () => {
  it("inserts without upsert and returns the input id", async () => {
    const artifact: Artifact = {
      id: "9f8e7d6c-5b4a-4321-abcd-ef0123456789",
      taskId: planFixture.tasks[0]!.id,
      kind: "review_report",
      uri: "s3://pm-go/reviews/review-report.json",
      createdAt: "2026-04-18T11:00:00.000Z",
    };

    const { db, calls } = createMockDb();
    const activities = createPlanPersistenceActivities({ db });
    const id = await activities.persistArtifact(artifact);

    expect(id).toBe(artifact.id);
    expect(calls.insert).toHaveLength(1);
    // Append-only: no onConflictDoUpdate on this path.
    expect(calls.onConflictDoUpdate).toHaveLength(0);
  });
});

describe("loadSpecDocument", () => {
  it("returns the spec-document row when found", async () => {
    const row = {
      id: specDocumentFixture.id,
      title: specDocumentFixture.title,
      source: specDocumentFixture.source,
      body: specDocumentFixture.body,
      createdAt: specDocumentFixture.createdAt,
    };
    const { db } = createMockDb({ specDocumentRows: [row] });
    const activities = createPlanPersistenceActivities({ db });
    const doc = await activities.loadSpecDocument(specDocumentFixture.id);
    expect(doc).toEqual(row);
  });

  it("throws when the row is absent", async () => {
    const { db } = createMockDb({ specDocumentRows: [] });
    const activities = createPlanPersistenceActivities({ db });
    await expect(
      activities.loadSpecDocument("00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/no spec_documents row/);
  });
});
