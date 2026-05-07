import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";
import type { AgentToolCall } from "../../execution.js";
import "./formats.js";

export const AgentToolCallStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed")
]);

const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());

export const AgentToolCallSchema = Type.Object(
  {
    id: UuidSchema,
    agentRunId: UuidSchema,
    sequence: Type.Optional(Type.Number()),
    toolName: Type.String(),
    sanitizedInput: JsonObjectSchema,
    summarizedOutput: Type.Optional(JsonObjectSchema),
    status: AgentToolCallStatusSchema,
    startedAt: Iso8601Schema,
    completedAt: Type.Optional(Iso8601Schema),
    errorReason: Type.Optional(Type.String()),
    specDocumentId: Type.Optional(UuidSchema),
    repoSnapshotId: Type.Optional(UuidSchema),
    planId: Type.Optional(UuidSchema),
    phaseId: Type.Optional(UuidSchema),
    taskId: Type.Optional(UuidSchema)
  },
  { $id: "AgentToolCall", additionalProperties: false }
);

export type AgentToolCallStatic = Static<typeof AgentToolCallSchema>;

export function validateAgentToolCall(value: unknown): value is AgentToolCall {
  return Value.Check(AgentToolCallSchema, value);
}

type _AgentToolCallAssignable =
  AgentToolCallStatic extends AgentToolCall ? true : never;
const _agentToolCallAssignable: _AgentToolCallAssignable = true;
void _agentToolCallAssignable;
