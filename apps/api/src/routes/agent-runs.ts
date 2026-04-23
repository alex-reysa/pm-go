import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";

import type { UUID } from "@pm-go/contracts";
import { agentRuns, type PmGoDb } from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

/**
 * Phase 6 agent-runs list endpoint. Supports the timeline view a
 * task-detail drawer needs — every agent run for a task, ordered by
 * `startedAt` DESC so the newest attempt lands first. Narrow
 * projection (no raw prompt / session data) because those live on
 * the row but aren't used by the UI in this commit.
 */
export interface AgentRunsRouteDeps {
  db: PmGoDb;
}

// UUID-layout check (not strict v4). See artifacts.ts for rationale.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

export function createAgentRunsRoute(deps: AgentRunsRouteDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const taskId = c.req.query("taskId");
    if (!isUuid(taskId)) {
      return c.json(
        { error: "taskId query param must be a UUID" },
        400,
      );
    }

    const rows = await deps.db
      .select({
        id: agentRuns.id,
        taskId: agentRuns.taskId,
        workflowRunId: agentRuns.workflowRunId,
        role: agentRuns.role,
        depth: agentRuns.depth,
        status: agentRuns.status,
        riskLevel: agentRuns.riskLevel,
        model: agentRuns.model,
        promptVersion: agentRuns.promptVersion,
        permissionMode: agentRuns.permissionMode,
        budgetUsdCap: agentRuns.budgetUsdCap,
        maxTurnsCap: agentRuns.maxTurnsCap,
        turns: agentRuns.turns,
        inputTokens: agentRuns.inputTokens,
        outputTokens: agentRuns.outputTokens,
        costUsd: agentRuns.costUsd,
        stopReason: agentRuns.stopReason,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .orderBy(desc(agentRuns.startedAt));

    return c.json(
      {
        taskId,
        agentRuns: rows.map((r) => ({
          id: r.id,
          ...(r.taskId !== null ? { taskId: r.taskId } : {}),
          workflowRunId: r.workflowRunId,
          role: r.role,
          depth: r.depth,
          status: r.status,
          riskLevel: r.riskLevel,
          model: r.model,
          promptVersion: r.promptVersion,
          permissionMode: r.permissionMode,
          ...(r.budgetUsdCap !== null ? { budgetUsdCap: r.budgetUsdCap } : {}),
          ...(r.maxTurnsCap !== null ? { maxTurnsCap: r.maxTurnsCap } : {}),
          ...(r.turns !== null ? { turns: r.turns } : {}),
          ...(r.inputTokens !== null ? { inputTokens: r.inputTokens } : {}),
          ...(r.outputTokens !== null ? { outputTokens: r.outputTokens } : {}),
          ...(r.costUsd !== null ? { costUsd: Number(r.costUsd) } : {}),
          ...(r.stopReason !== null ? { stopReason: r.stopReason } : {}),
          ...(r.startedAt !== null ? { startedAt: toIso(r.startedAt) } : {}),
          ...(r.completedAt !== null
            ? { completedAt: toIso(r.completedAt) }
            : {}),
        })),
      },
      200,
    );
  });

  return app;
}
