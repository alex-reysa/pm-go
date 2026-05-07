import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-runs.js";
import { phases } from "./phases.js";
import { planTasks } from "./plan-tasks.js";
import { plans } from "./plans.js";
import { repoSnapshots } from "./repo-snapshots.js";
import { specDocuments } from "./spec-documents.js";

export const agentToolCallStatus = pgEnum("agent_tool_call_status", [
  "running",
  "completed",
  "failed",
]);

type JsonObject = Record<string, unknown>;

export const agentToolCalls = pgTable(
  "agent_tool_calls",
  {
    id: uuid("id").primaryKey(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence"),
    toolName: text("tool_name").notNull(),
    sanitizedInput: jsonb("sanitized_input")
      .$type<JsonObject>()
      .notNull()
      .default({}),
    summarizedOutput: jsonb("summarized_output").$type<JsonObject>(),
    status: agentToolCallStatus("status").notNull(),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    errorReason: text("error_reason"),
    specDocumentId: uuid("spec_document_id").references(() => specDocuments.id, {
      onDelete: "set null",
    }),
    repoSnapshotId: uuid("repo_snapshot_id").references(() => repoSnapshots.id, {
      onDelete: "set null",
    }),
    planId: uuid("plan_id").references(() => plans.id, {
      onDelete: "set null",
    }),
    phaseId: uuid("phase_id").references(() => phases.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => planTasks.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    agentRunIdx: index("agent_tool_calls_agent_run_id_idx").on(table.agentRunId),
    planIdx: index("agent_tool_calls_plan_id_idx").on(table.planId),
    phaseIdx: index("agent_tool_calls_phase_id_idx").on(table.phaseId),
    taskIdx: index("agent_tool_calls_task_id_idx").on(table.taskId),
    specDocumentIdx: index("agent_tool_calls_spec_document_id_idx").on(
      table.specDocumentId,
    ),
    repoSnapshotIdx: index("agent_tool_calls_repo_snapshot_id_idx").on(
      table.repoSnapshotId,
    ),
  }),
);

export type AgentToolCallsRow = typeof agentToolCalls.$inferSelect;
export type AgentToolCallsInsert = typeof agentToolCalls.$inferInsert;
