import { describe, it, expect, vi } from "vitest";

import { createApp } from "../src/app.js";

function makeMockTemporal() {
  const start = vi.fn().mockResolvedValue({
    firstExecutionRunId: "run-task-xyz",
    workflowId: "wf-task-xyz",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = { workflow: { start } } as any;
  return { start, client };
}

/**
 * Minimal chainable drizzle mock for the /tasks GET path:
 * `.select(...).from(...).where(...).limit(...)` and
 * `.select(...).from(...).where(...).orderBy(...).limit(...)`.
 * Each successive `.select(...)` invocation returns the next rowset in
 * `rowsPerSelect`.
 */
function makeMockDbForLookup(rowsPerSelect: unknown[][]) {
  let i = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = rowsPerSelect[i++] ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ limit, orderBy });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { select } as any;
}

const APP_DEFAULTS = {
  taskQueue: "pm-go-worker",
  artifactDir: "./artifacts/plans",
  repoRoot: "/tmp/repo",
  worktreeRoot: "/tmp/repo/.worktrees",
  maxLifetimeHours: 24,
};

describe("POST /tasks/:taskId/run", () => {
  it("starts TaskExecutionWorkflow and returns 202 with taskId + workflowRunId", async () => {
    const { start, client } = makeMockTemporal();

    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });

    const taskId = "11111111-2222-4333-8444-555555555555";
    const res = await app.request(`/tasks/${taskId}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    const payload = (await res.json()) as {
      taskId: string;
      workflowRunId: string;
    };
    expect(payload.taskId).toBe(taskId);
    expect(payload.workflowRunId).toBe("run-task-xyz");

    expect(start).toHaveBeenCalledWith(
      "TaskExecutionWorkflow",
      expect.objectContaining({
        taskQueue: APP_DEFAULTS.taskQueue,
        workflowId: `task-exec-${taskId}`,
        args: [
          {
            taskId,
            repoRoot: APP_DEFAULTS.repoRoot,
            worktreeRoot: APP_DEFAULTS.worktreeRoot,
            maxLifetimeHours: APP_DEFAULTS.maxLifetimeHours,
            requestedBy: "api",
          },
        ],
      }),
    );
  });

  it("returns 400 when taskId is not a UUID", async () => {
    const { client } = makeMockTemporal();

    const app = createApp({
      temporal: client,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      ...APP_DEFAULTS,
    });

    const res = await app.request(`/tasks/not-a-uuid/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /tasks/:taskId", () => {
  it("returns 404 when the task row is missing", async () => {
    const { client } = makeMockTemporal();
    const db = makeMockDbForLookup([[]]);

    const app = createApp({
      temporal: client,
      db,
      ...APP_DEFAULTS,
    });

    const res = await app.request(
      `/tasks/11111111-2222-4333-8444-555555555555`,
    );
    expect(res.status).toBe(404);
  });
});
