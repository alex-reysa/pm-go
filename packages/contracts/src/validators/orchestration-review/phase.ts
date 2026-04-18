import { Type, type Static } from "@sinclair/typebox";

import type { Phase } from "../../plan.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import { DependencyEdgeSchema } from "./dependency-edge.js";

/**
 * Enumerated `PhaseStatus` values, mirrored from `plan.ts`.
 */
export const PhaseStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("planning"),
  Type.Literal("executing"),
  Type.Literal("integrating"),
  Type.Literal("auditing"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("failed")
]);

/**
 * TypeBox schema for `Phase`. A `Plan` carries an ordered array of these.
 */
export const PhaseSchema = Type.Object({
  id: UuidSchema,
  planId: UuidSchema,
  index: Type.Integer({ minimum: 0 }),
  title: Type.String(),
  summary: Type.String(),
  status: PhaseStatusSchema,
  integrationBranch: Type.String(),
  baseSnapshotId: UuidSchema,
  taskIds: Type.Array(UuidSchema),
  dependencyEdges: Type.Array(DependencyEdgeSchema),
  mergeOrder: Type.Array(UuidSchema),
  phaseAuditReportId: Type.Optional(UuidSchema),
  startedAt: Type.Optional(Iso8601Schema),
  completedAt: Type.Optional(Iso8601Schema)
}, { $id: "Phase", additionalProperties: false });

export type PhaseSchemaType = Static<typeof PhaseSchema>;

type _PhaseSubtypeCheck = PhaseSchemaType extends Phase ? true : never;
const _phaseOk: _PhaseSubtypeCheck = true;
void _phaseOk;
