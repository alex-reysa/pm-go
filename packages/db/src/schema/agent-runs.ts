import { sql } from "drizzle-orm";
import {
  check,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { planTasks } from "./plan-tasks.js";
import { riskLevel } from "./plan-tasks.js";

export const agentRole = pgEnum("agent_role", [
  "planner",
  "partitioner",
  "implementer",
  "auditor",
  "integrator",
  "release-reviewer",
  "explorer",
]);

export const agentRunStatus = pgEnum("agent_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
  "canceled",
]);

export const agentStopReason = pgEnum("agent_stop_reason", [
  "completed",
  "budget_exceeded",
  "turns_exceeded",
  "timeout",
  "canceled",
  "error",
  "scope_violation",
]);

export const agentPermissionMode = pgEnum("agent_permission_mode", [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "set null",
    }),
    workflowRunId: text("workflow_run_id").notNull(),
    role: agentRole("role").notNull(),
    depth: integer("depth").notNull(),
    status: agentRunStatus("status").notNull(),
    riskLevel: riskLevel("risk_level").notNull(),
    executor: text("executor").notNull().default("claude"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    sessionId: text("session_id"),
    parentSessionId: text("parent_session_id"),
    permissionMode: agentPermissionMode("permission_mode").notNull(),
    budgetUsdCap: numeric("budget_usd_cap", { precision: 10, scale: 4 }),
    maxTurnsCap: integer("max_turns_cap"),
    turns: integer("turns"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    stopReason: agentStopReason("stop_reason"),
    outputFormatSchemaRef: text("output_format_schema_ref"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table) => ({
    depthRange: check(
      "agent_runs_depth_range",
      sql`${table.depth} >= 0 AND ${table.depth} <= 2`,
    ),
  }),
);

export type AgentRunsRow = typeof agentRuns.$inferSelect;
export type AgentRunsInsert = typeof agentRuns.$inferInsert;
