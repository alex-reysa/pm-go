import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { and, asc, desc, eq } from "drizzle-orm";

import type {
  AgentPermissionMode,
  AgentExecutor,
  AgentRole,
  AgentRunStatus,
  AgentStopReason,
  AgentToolCallStatus,
  RiskLevel,
  UUID,
} from "@pm-go/contracts";
import {
  agentRuns,
  agentToolCalls,
  type AgentRunsInsert,
  type AgentToolCallsInsert,
  type PmGoDb,
} from "@pm-go/db";

import { toIso } from "../lib/timestamps.js";

export interface AgentRunsRouteDeps {
  db: PmGoDb;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_ROLES = new Set<AgentRole>([
  "orchestrator",
  "planner",
  "partitioner",
  "implementer",
  "auditor",
  "integrator",
  "release-reviewer",
  "explorer",
]);
const RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "canceled",
]);
const RISK_LEVELS = new Set<RiskLevel>(["low", "medium", "high"]);
const AGENT_EXECUTORS = new Set<AgentExecutor>(["claude", "codex"]);
const PERMISSION_MODES = new Set<AgentPermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
const STOP_REASONS = new Set<AgentStopReason>([
  "completed",
  "budget_exceeded",
  "turns_exceeded",
  "timeout",
  "canceled",
  "error",
  "scope_violation",
]);
const TOOL_STATUSES = new Set<AgentToolCallStatus>([
  "running",
  "completed",
  "failed",
]);

function isUuid(value: unknown): value is UUID {
  return typeof value === "string" && UUID_RE.test(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asInteger(value: unknown): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function asIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function asJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function rowToAgentRun(row: Record<string, unknown>) {
  return {
    id: row.id,
    ...(present(row.taskId) ? { taskId: row.taskId } : {}),
    ...(present(row.planId) ? { planId: row.planId } : {}),
    workflowRunId: row.workflowRunId,
    role: row.role,
    depth: row.depth,
    status: row.status,
    riskLevel: row.riskLevel,
    executor: row.executor ?? "claude",
    model: row.model,
    promptVersion: row.promptVersion,
    ...(present(row.sessionId) ? { sessionId: row.sessionId } : {}),
    ...(present(row.parentSessionId)
      ? { parentSessionId: row.parentSessionId }
      : {}),
    permissionMode: row.permissionMode,
    ...(present(row.budgetUsdCap)
      ? { budgetUsdCap: Number(row.budgetUsdCap) }
      : {}),
    ...(present(row.maxTurnsCap) ? { maxTurnsCap: row.maxTurnsCap } : {}),
    ...(present(row.turns) ? { turns: row.turns } : {}),
    ...(present(row.inputTokens) ? { inputTokens: row.inputTokens } : {}),
    ...(present(row.outputTokens) ? { outputTokens: row.outputTokens } : {}),
    ...(present(row.cacheCreationTokens)
      ? { cacheCreationTokens: row.cacheCreationTokens }
      : {}),
    ...(present(row.cacheReadTokens)
      ? { cacheReadTokens: row.cacheReadTokens }
      : {}),
    ...(present(row.costUsd) ? { costUsd: Number(row.costUsd) } : {}),
    ...(present(row.stopReason) ? { stopReason: row.stopReason } : {}),
    ...(present(row.outputFormatSchemaRef)
      ? { outputFormatSchemaRef: row.outputFormatSchemaRef }
      : {}),
    ...(present(row.startedAt) ? { startedAt: toIso(String(row.startedAt)) } : {}),
    ...(present(row.completedAt)
      ? { completedAt: toIso(String(row.completedAt)) }
      : {}),
    ...(present(row.errorReason) ? { errorReason: row.errorReason } : {}),
  };
}

function rowToToolCall(row: Record<string, unknown>) {
  return {
    id: row.id,
    agentRunId: row.agentRunId,
    ...(present(row.sequence) ? { sequence: row.sequence } : {}),
    toolName: row.toolName,
    sanitizedInput: row.sanitizedInput,
    ...(present(row.summarizedOutput)
      ? { summarizedOutput: row.summarizedOutput }
      : {}),
    status: row.status,
    ...(present(row.startedAt) ? { startedAt: toIso(String(row.startedAt)) } : {}),
    ...(present(row.completedAt)
      ? { completedAt: toIso(String(row.completedAt)) }
      : {}),
    ...(present(row.errorReason) ? { errorReason: row.errorReason } : {}),
    ...(present(row.specDocumentId)
      ? { specDocumentId: row.specDocumentId }
      : {}),
    ...(present(row.repoSnapshotId)
      ? { repoSnapshotId: row.repoSnapshotId }
      : {}),
    ...(present(row.planId) ? { planId: row.planId } : {}),
    ...(present(row.phaseId) ? { phaseId: row.phaseId } : {}),
    ...(present(row.taskId) ? { taskId: row.taskId } : {}),
  };
}

function parseAgentRunBody(raw: unknown, requireCreateFields: boolean) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "missing JSON body" } as const;
  }
  const body = raw as Record<string, unknown>;
  const values: Record<string, unknown> = {};

  if (body.id !== undefined) {
    if (!isUuid(body.id)) return { error: "id must be a UUID" } as const;
    values.id = body.id;
  }
  for (const key of ["taskId", "planId"] as const) {
    if (body[key] !== undefined) {
      if (!isUuid(body[key])) return { error: `${key} must be a UUID` } as const;
      values[key] = body[key];
    }
  }

  const stringFields = [
    "workflowRunId",
    "model",
    "promptVersion",
    "sessionId",
    "parentSessionId",
    "outputFormatSchemaRef",
    "errorReason",
  ] as const;
  for (const key of stringFields) {
    if (body[key] !== undefined) {
      const value = asNonEmptyString(body[key]);
      if (!value) return { error: `${key} must be a non-empty string` } as const;
      values[key] = value;
    }
  }

  if (body.role !== undefined) {
    if (!AGENT_ROLES.has(body.role as AgentRole)) {
      return { error: "role must be a known AgentRole" } as const;
    }
    values.role = body.role;
  }
  if (body.depth !== undefined) {
    const depth = asInteger(body.depth);
    if (depth !== 0 && depth !== 1 && depth !== 2) {
      return { error: "depth must be 0, 1, or 2" } as const;
    }
    values.depth = depth;
  }
  if (body.status !== undefined) {
    if (!RUN_STATUSES.has(body.status as AgentRunStatus)) {
      return { error: "status must be a known AgentRunStatus" } as const;
    }
    values.status = body.status;
  }
  if (body.riskLevel !== undefined) {
    if (!RISK_LEVELS.has(body.riskLevel as RiskLevel)) {
      return { error: "riskLevel must be low, medium, or high" } as const;
    }
    values.riskLevel = body.riskLevel;
  }
  if (body.executor !== undefined) {
    if (!AGENT_EXECUTORS.has(body.executor as AgentExecutor)) {
      return { error: "executor must be claude or codex" } as const;
    }
    values.executor = body.executor;
  }
  if (body.permissionMode !== undefined) {
    if (!PERMISSION_MODES.has(body.permissionMode as AgentPermissionMode)) {
      return { error: "permissionMode must be a known AgentPermissionMode" } as const;
    }
    values.permissionMode = body.permissionMode;
  }
  if (body.stopReason !== undefined) {
    if (!STOP_REASONS.has(body.stopReason as AgentStopReason)) {
      return { error: "stopReason must be a known AgentStopReason" } as const;
    }
    values.stopReason = body.stopReason;
  }

  for (const key of ["budgetUsdCap", "costUsd"] as const) {
    if (body[key] !== undefined) {
      const value = asNumber(body[key]);
      if (value === undefined) return { error: `${key} must be numeric` } as const;
      values[key] = value;
    }
  }
  for (const key of [
    "maxTurnsCap",
    "turns",
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
  ] as const) {
    if (body[key] !== undefined) {
      const value = asInteger(body[key]);
      if (value === undefined) return { error: `${key} must be an integer` } as const;
      values[key] = value;
    }
  }
  for (const key of ["startedAt", "completedAt"] as const) {
    if (body[key] !== undefined) {
      const value = asIso(body[key]);
      if (!value) return { error: `${key} must be an ISO timestamp` } as const;
      values[key] = value;
    }
  }

  if (requireCreateFields) {
    const required = [
      "workflowRunId",
      "role",
      "depth",
      "status",
      "riskLevel",
      "model",
      "promptVersion",
      "permissionMode",
    ];
    for (const key of required) {
      if (values[key] === undefined) return { error: `${key} is required` } as const;
    }
    values.id ??= randomUUID();
    values.executor ??= "claude";
  }
  return { values } as const;
}

function parseToolCallBody(
  raw: unknown,
  agentRunId: UUID,
  requireCreateFields: boolean,
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "missing JSON body" } as const;
  }
  const body = raw as Record<string, unknown>;
  const values: Record<string, unknown> = {};

  if (body.id !== undefined) {
    if (!isUuid(body.id)) return { error: "id must be a UUID" } as const;
    values.id = body.id;
  }
  values.agentRunId = agentRunId;

  if (body.sequence !== undefined) {
    const sequence = asInteger(body.sequence);
    if (sequence === undefined) return { error: "sequence must be an integer" } as const;
    values.sequence = sequence;
  }
  if (body.toolName !== undefined) {
    const toolName = asNonEmptyString(body.toolName);
    if (!toolName) return { error: "toolName must be a non-empty string" } as const;
    values.toolName = toolName;
  }
  if (body.sanitizedInput !== undefined) {
    const sanitizedInput = asJsonObject(body.sanitizedInput);
    if (!sanitizedInput) return { error: "sanitizedInput must be an object" } as const;
    values.sanitizedInput = sanitizedInput;
  }
  if (body.summarizedOutput !== undefined) {
    if (body.summarizedOutput === null) {
      values.summarizedOutput = null;
    } else {
      const summarizedOutput = asJsonObject(body.summarizedOutput);
      if (!summarizedOutput) {
        return { error: "summarizedOutput must be an object" } as const;
      }
      values.summarizedOutput = summarizedOutput;
    }
  }
  if (body.status !== undefined) {
    if (!TOOL_STATUSES.has(body.status as AgentToolCallStatus)) {
      return { error: "status must be running, completed, or failed" } as const;
    }
    values.status = body.status;
  }
  if (body.errorReason !== undefined) {
    if (body.errorReason === null) {
      values.errorReason = null;
    } else {
      const errorReason = asNonEmptyString(body.errorReason);
      if (!errorReason) return { error: "errorReason must be a string" } as const;
      values.errorReason = errorReason;
    }
  }
  for (const key of ["startedAt", "completedAt"] as const) {
    if (body[key] !== undefined) {
      const value = asIso(body[key]);
      if (!value) return { error: `${key} must be an ISO timestamp` } as const;
      values[key] = value;
    }
  }
  for (const key of [
    "specDocumentId",
    "repoSnapshotId",
    "planId",
    "phaseId",
    "taskId",
  ] as const) {
    if (body[key] !== undefined) {
      if (body[key] === null) {
        values[key] = null;
      } else if (isUuid(body[key])) {
        values[key] = body[key];
      } else {
        return { error: `${key} must be a UUID` } as const;
      }
    }
  }

  if (requireCreateFields) {
    for (const key of ["toolName", "sanitizedInput", "status"] as const) {
      if (values[key] === undefined) return { error: `${key} is required` } as const;
    }
    values.id ??= randomUUID();
    values.startedAt ??= new Date().toISOString();
  }
  return { values } as const;
}

export function createAgentRunsRoute(deps: AgentRunsRouteDeps) {
  const app = new Hono();

  app.get("/", async (c) => {
    const taskId = c.req.query("taskId");
    const planId = c.req.query("planId");
    const role = c.req.query("role");

    if (taskId !== undefined && planId !== undefined) {
      return c.json({ error: "pass taskId or planId, not both" }, 400);
    }
    if (taskId !== undefined && !isUuid(taskId)) {
      return c.json({ error: "taskId query param must be a UUID" }, 400);
    }
    if (planId !== undefined && !isUuid(planId)) {
      return c.json({ error: "planId query param must be a UUID" }, 400);
    }
    if (role !== undefined && !AGENT_ROLES.has(role as AgentRole)) {
      return c.json({ error: "role query param must be a known AgentRole" }, 400);
    }
    if (taskId === undefined && planId === undefined) {
      return c.json({ error: "taskId or planId query param must be a UUID" }, 400);
    }

    const roleFilter = role as AgentRole | undefined;
    const where =
      taskId !== undefined
        ? eq(agentRuns.taskId, taskId)
        : roleFilter !== undefined
          ? and(eq(agentRuns.planId, planId!), eq(agentRuns.role, roleFilter))
          : eq(agentRuns.planId, planId!);

    const rows = await deps.db
      .select({
        id: agentRuns.id,
        taskId: agentRuns.taskId,
        planId: agentRuns.planId,
        workflowRunId: agentRuns.workflowRunId,
        role: agentRuns.role,
        depth: agentRuns.depth,
        status: agentRuns.status,
        riskLevel: agentRuns.riskLevel,
        executor: agentRuns.executor,
        model: agentRuns.model,
        promptVersion: agentRuns.promptVersion,
        sessionId: agentRuns.sessionId,
        parentSessionId: agentRuns.parentSessionId,
        permissionMode: agentRuns.permissionMode,
        budgetUsdCap: agentRuns.budgetUsdCap,
        maxTurnsCap: agentRuns.maxTurnsCap,
        turns: agentRuns.turns,
        inputTokens: agentRuns.inputTokens,
        outputTokens: agentRuns.outputTokens,
        cacheCreationTokens: agentRuns.cacheCreationTokens,
        cacheReadTokens: agentRuns.cacheReadTokens,
        costUsd: agentRuns.costUsd,
        stopReason: agentRuns.stopReason,
        outputFormatSchemaRef: agentRuns.outputFormatSchemaRef,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        errorReason: agentRuns.errorReason,
      })
      .from(agentRuns)
      .where(where)
      .orderBy(desc(agentRuns.startedAt));

    return c.json(
      {
        ...(taskId !== undefined ? { taskId } : { planId }),
        agentRuns: rows.map((r) => rowToAgentRun(r)),
      },
      200,
    );
  });

  app.post("/", async (c) => {
    const parsed = parseAgentRunBody(await c.req.json().catch(() => null), true);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    await deps.db.insert(agentRuns).values(parsed.values as AgentRunsInsert);
    return c.json({ agentRun: rowToAgentRun(parsed.values) }, 201);
  });

  app.patch("/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!isUuid(runId)) return c.json({ error: "runId must be a UUID" }, 400);
    const parsed = parseAgentRunBody(await c.req.json().catch(() => null), false);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.values).length === 0) {
      return c.json({ error: "no supported fields to update" }, 400);
    }
    await deps.db.update(agentRuns).set(parsed.values).where(eq(agentRuns.id, runId));
    return c.json({ agentRun: rowToAgentRun({ id: runId, ...parsed.values }) }, 200);
  });

  app.get("/:runId/tool-calls", async (c) => {
    const runId = c.req.param("runId");
    if (!isUuid(runId)) return c.json({ error: "runId must be a UUID" }, 400);

    const rows = await deps.db
      .select({
        id: agentToolCalls.id,
        agentRunId: agentToolCalls.agentRunId,
        sequence: agentToolCalls.sequence,
        toolName: agentToolCalls.toolName,
        sanitizedInput: agentToolCalls.sanitizedInput,
        summarizedOutput: agentToolCalls.summarizedOutput,
        status: agentToolCalls.status,
        startedAt: agentToolCalls.startedAt,
        completedAt: agentToolCalls.completedAt,
        errorReason: agentToolCalls.errorReason,
        specDocumentId: agentToolCalls.specDocumentId,
        repoSnapshotId: agentToolCalls.repoSnapshotId,
        planId: agentToolCalls.planId,
        phaseId: agentToolCalls.phaseId,
        taskId: agentToolCalls.taskId,
      })
      .from(agentToolCalls)
      .where(eq(agentToolCalls.agentRunId, runId))
      .orderBy(asc(agentToolCalls.sequence), asc(agentToolCalls.startedAt));

    return c.json(
      {
        agentRunId: runId,
        toolCalls: rows.map((r) => rowToToolCall(r)),
      },
      200,
    );
  });

  app.post("/:runId/tool-calls", async (c) => {
    const runId = c.req.param("runId");
    if (!isUuid(runId)) return c.json({ error: "runId must be a UUID" }, 400);
    const parsed = parseToolCallBody(
      await c.req.json().catch(() => null),
      runId,
      true,
    );
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    await deps.db
      .insert(agentToolCalls)
      .values(parsed.values as AgentToolCallsInsert);
    return c.json({ toolCall: rowToToolCall(parsed.values) }, 201);
  });

  app.patch("/:runId/tool-calls/:toolCallId", async (c) => {
    const runId = c.req.param("runId");
    const toolCallId = c.req.param("toolCallId");
    if (!isUuid(runId)) return c.json({ error: "runId must be a UUID" }, 400);
    if (!isUuid(toolCallId)) {
      return c.json({ error: "toolCallId must be a UUID" }, 400);
    }
    const parsed = parseToolCallBody(
      await c.req.json().catch(() => null),
      runId,
      false,
    );
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const { agentRunId: _agentRunId, ...update } = parsed.values;
    void _agentRunId;
    if (Object.keys(update).length === 0) {
      return c.json({ error: "no supported fields to update" }, 400);
    }
    await deps.db
      .update(agentToolCalls)
      .set(update)
      .where(
        and(
          eq(agentToolCalls.id, toolCallId),
          eq(agentToolCalls.agentRunId, runId),
        ),
      );
    return c.json(
      { toolCall: rowToToolCall({ id: toolCallId, agentRunId: runId, ...update }) },
      200,
    );
  });

  return app;
}
