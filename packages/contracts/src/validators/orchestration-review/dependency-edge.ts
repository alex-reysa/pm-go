import { Type, type Static } from "@sinclair/typebox";

import type { DependencyEdge } from "../../plan.js";
import { UuidSchema } from "../../shared/schema.js";

/**
 * TypeBox schema for `DependencyEdge`. Used inside `Phase.dependencyEdges`.
 */
export const DependencyEdgeSchema = Type.Object({
  fromTaskId: UuidSchema,
  toTaskId: UuidSchema,
  reason: Type.String(),
  required: Type.Boolean()
}, { $id: "DependencyEdge", additionalProperties: false });

export type DependencyEdgeSchemaType = Static<typeof DependencyEdgeSchema>;

type _DependencyEdgeSubtypeCheck = DependencyEdgeSchemaType extends DependencyEdge
  ? true
  : never;
const _depOk: _DependencyEdgeSubtypeCheck = true;
void _depOk;
