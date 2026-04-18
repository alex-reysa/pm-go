import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { Plan } from "../../plan.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { PhaseSchema } from "./phase.js";
import { RiskSchema } from "./risk.js";
import { TaskSchema } from "./task.js";

/**
 * Enumerated `PlanStatus` values, mirrored from `plan.ts`.
 */
export const PlanStatusSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("auditing"),
  Type.Literal("approved"),
  Type.Literal("blocked"),
  Type.Literal("executing"),
  Type.Literal("completed"),
  Type.Literal("failed")
]);

/**
 * TypeBox schema for `Plan` from `packages/contracts/src/plan.ts`.
 * Doubles as a JSON Schema that the Claude Agent SDK executor adapter
 * can consume directly.
 */
export const PlanSchema = Type.Object({
  id: UuidSchema,
  specDocumentId: UuidSchema,
  repoSnapshotId: UuidSchema,
  title: Type.String(),
  summary: Type.String(),
  status: PlanStatusSchema,
  phases: Type.Array(PhaseSchema),
  tasks: Type.Array(TaskSchema),
  risks: Type.Array(RiskSchema),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema
}, { $id: "Plan", additionalProperties: false });

export type PlanSchemaType = Static<typeof PlanSchema>;

/**
 * Compile-time directional subtype check — `Static<typeof PlanSchema>`
 * must be assignable to the authoritative `Plan` interface.
 */
type _PlanSubtypeCheck = PlanSchemaType extends Plan ? true : never;
const _planOk: _PlanSubtypeCheck = true;
void _planOk;

/**
 * Runtime validator for `Plan`. Returns a TypeScript type predicate so
 * callers can narrow `unknown` to `Plan` after a successful check.
 */
export function validatePlan(value: unknown): value is Plan {
  return Value.Check(PlanSchema, value);
}
