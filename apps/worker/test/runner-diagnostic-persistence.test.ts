import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunnerDiagnosticArtifact } from "@pm-go/executor-claude";

import { createPlanPersistenceActivities } from "../src/activities/plan-persistence.js";

/**
 * v0.8.2.1 P1.4: persistRunnerDiagnostic must write the JSON payload
 * under <artifactDir>/runner-diagnostics/<id>.json AND insert an
 * `artifacts` row when a planId can be derived from the diagnostic's
 * sessionId. When neither can be derived, the on-disk JSON is still
 * the authoritative artifact (DB row skipped to respect the
 * artifacts.taskId-or-planId CHECK constraint).
 */

const ARTIFACT_ID = "33333333-2222-4333-8444-555555555555";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";

function buildArtifact(
  overrides: Partial<RunnerDiagnosticArtifact> = {},
): RunnerDiagnosticArtifact {
  return {
    id: ARTIFACT_ID,
    role: "reviewer",
    schemaRef: "ReviewReport@1",
    validationErrorSummary: "missing required field 'outcome'",
    sanitizedStructuredOutput: { taskId: TASK_ID, findings: [] },
    sdkResultSubtype: "success",
    sessionId: "session-abc",
    createdAt: "2026-04-25T10:00:00.000Z",
    ...overrides,
  };
}

function makeMockDbForDiagnostic(opts: {
  sessionLookup?: Array<{ taskId: string | null }>;
  taskLookup?: Array<{ planId: string }>;
  insertCalls?: Array<{ values: unknown }>;
}) {
  const queue: unknown[][] = [
    opts.sessionLookup ?? [],
    opts.taskLookup ?? [],
  ];
  let i = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    select: vi.fn().mockImplementation(() => {
      const rows = queue[i++] ?? [];
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    }),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values: unknown) => {
        opts.insertCalls?.push({ values });
        return Promise.resolve(undefined);
      }),
    })),
  };
  return db;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pm-go-runner-diag-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("persistRunnerDiagnostic (v0.8.2.1 P1.4)", () => {
  it("writes the sanitized JSON to disk under runner-diagnostics/<id>.json", async () => {
    const insertCalls: Array<{ values: unknown }> = [];
    const db = makeMockDbForDiagnostic({
      sessionLookup: [{ taskId: TASK_ID }],
      taskLookup: [{ planId: PLAN_ID }],
      insertCalls,
    });
    const acts = createPlanPersistenceActivities({ db, artifactDir: tmpDir });
    const artifact = buildArtifact();

    const result = await acts.persistRunnerDiagnostic(artifact);

    expect(result.artifactRowId).toBe(ARTIFACT_ID);
    expect(result.uri).toBe(
      join(tmpDir, "runner-diagnostics", `${ARTIFACT_ID}.json`),
    );
    const onDisk = JSON.parse(await readFile(result.uri, "utf8"));
    expect(onDisk.id).toBe(ARTIFACT_ID);
    expect(onDisk.role).toBe("reviewer");
    expect(onDisk.schemaRef).toBe("ReviewReport@1");
  });

  it("inserts an artifacts row with kind='runner_diagnostic' when planId derives from the session", async () => {
    const insertCalls: Array<{ values: unknown }> = [];
    const db = makeMockDbForDiagnostic({
      sessionLookup: [{ taskId: TASK_ID }],
      taskLookup: [{ planId: PLAN_ID }],
      insertCalls,
    });
    const acts = createPlanPersistenceActivities({ db, artifactDir: tmpDir });
    await acts.persistRunnerDiagnostic(buildArtifact());

    expect(insertCalls).toHaveLength(1);
    const values = insertCalls[0]!.values as {
      id: string;
      kind: string;
      planId: string | null;
      taskId: string | null;
    };
    expect(values.id).toBe(ARTIFACT_ID);
    expect(values.kind).toBe("runner_diagnostic");
    expect(values.planId).toBe(PLAN_ID);
    expect(values.taskId).toBeNull();
  });

  it("skips the DB row but still writes the JSON when no planId can be derived", async () => {
    const insertCalls: Array<{ values: unknown }> = [];
    const db = makeMockDbForDiagnostic({
      sessionLookup: [], // no agent_runs row matches
      insertCalls,
    });
    const acts = createPlanPersistenceActivities({ db, artifactDir: tmpDir });
    const result = await acts.persistRunnerDiagnostic(buildArtifact());

    expect(insertCalls).toHaveLength(0);
    // File is still authoritative.
    const onDisk = await readFile(result.uri, "utf8");
    expect(JSON.parse(onDisk).id).toBe(ARTIFACT_ID);
  });

  it("handles a diagnostic without sessionId (no DB lookup attempted)", async () => {
    const insertCalls: Array<{ values: unknown }> = [];
    const db = makeMockDbForDiagnostic({ insertCalls });
    const acts = createPlanPersistenceActivities({ db, artifactDir: tmpDir });
    const artifact = buildArtifact();
    delete artifact.sessionId;

    const result = await acts.persistRunnerDiagnostic(artifact);

    expect(insertCalls).toHaveLength(0);
    // File still landed.
    const onDisk = await readFile(result.uri, "utf8");
    expect(JSON.parse(onDisk).role).toBe("reviewer");
  });
});
