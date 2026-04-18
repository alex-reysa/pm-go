import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";
import type { AgentRun } from "../../execution.js";
// Register `uuid` and `date-time` formats in the TypeBox
// FormatRegistry. Side-effect import — see ./formats.ts.
import "./formats.js";

/**
 * Union schemas mirroring the string-literal unions declared in
 * `packages/contracts/src/execution.ts` and `plan.ts`. Kept local to
 * this module to avoid cross-lane helper proliferation.
 */
export const AgentRoleSchema = Type.Union([
  Type.Literal("planner"),
  Type.Literal("partitioner"),
  Type.Literal("implementer"),
  Type.Literal("auditor"),
  Type.Literal("integrator"),
  Type.Literal("release-reviewer"),
  Type.Literal("explorer")
]);

export const AgentRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("timed_out"),
  Type.Literal("canceled")
]);

export const AgentStopReasonSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("budget_exceeded"),
  Type.Literal("turns_exceeded"),
  Type.Literal("timeout"),
  Type.Literal("canceled"),
  Type.Literal("error"),
  Type.Literal("scope_violation")
]);

export const AgentPermissionModeSchema = Type.Union([
  Type.Literal("default"),
  Type.Literal("acceptEdits"),
  Type.Literal("bypassPermissions"),
  Type.Literal("plan")
]);

export const RiskLevelSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high")
]);

/**
 * Depth literal `0 | 1 | 2`. Encoded as a union of literals so that
 * the emitted JSON Schema correctly enumerates the allowed values.
 */
export const AgentDepthSchema = Type.Union([
  Type.Literal(0),
  Type.Literal(1),
  Type.Literal(2)
]);

/**
 * TypeBox schema for {@link AgentRun}. Required fields: `id`,
 * `workflowRunId`, `role`, `depth`, `status`, `riskLevel`, `executor`,
 * `model`, `promptVersion`, `permissionMode`. All other fields are
 * optional and correspond to SDK-returned session/cost/token metadata.
 */
export const AgentRunSchema = Type.Object(
  {
    id: UuidSchema,
    taskId: Type.Optional(UuidSchema),
    workflowRunId: Type.String(),
    role: AgentRoleSchema,
    depth: AgentDepthSchema,
    status: AgentRunStatusSchema,
    riskLevel: RiskLevelSchema,
    executor: Type.Literal("claude"),
    model: Type.String(),
    promptVersion: Type.String(),
    sessionId: Type.Optional(Type.String()),
    parentSessionId: Type.Optional(Type.String()),
    permissionMode: AgentPermissionModeSchema,
    budgetUsdCap: Type.Optional(Type.Number()),
    maxTurnsCap: Type.Optional(Type.Number()),
    turns: Type.Optional(Type.Number()),
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    cacheCreationTokens: Type.Optional(Type.Number()),
    cacheReadTokens: Type.Optional(Type.Number()),
    costUsd: Type.Optional(Type.Number()),
    stopReason: Type.Optional(AgentStopReasonSchema),
    outputFormatSchemaRef: Type.Optional(Type.String()),
    startedAt: Type.Optional(Iso8601Schema),
    completedAt: Type.Optional(Iso8601Schema)
  },
  { $id: "AgentRun", additionalProperties: false }
);

export type AgentRunStatic = Static<typeof AgentRunSchema>;

/**
 * Runtime validator. Returns `true` iff `value` conforms to
 * {@link AgentRunSchema}, narrowing to {@link AgentRun}.
 */
export function validateAgentRun(value: unknown): value is AgentRun {
  return Value.Check(AgentRunSchema, value);
}

// Compile-time assertion: structural compatibility with the authoritative
// `AgentRun` interface. One-way `extends` check tolerates TypeBox's
// `?: T | undefined` optional encoding vs. the interface's `?: T`.
type _AgentRunAssignable = AgentRunStatic extends AgentRun ? true : never;
const _agentRunAssignable: _AgentRunAssignable = true;
void _agentRunAssignable;
