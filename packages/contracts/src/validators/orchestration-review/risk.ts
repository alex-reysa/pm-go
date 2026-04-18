import { Type, type Static } from "@sinclair/typebox";

import type { Risk } from "../../plan.js";

/**
 * Enumerated `RiskLevel` values, mirrored from `plan.ts`. Also reused by
 * `Task.riskLevel`.
 */
export const RiskLevelSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high")
]);

/**
 * TypeBox schema for `Risk`.
 */
export const RiskSchema = Type.Object({
  id: Type.String(),
  level: RiskLevelSchema,
  title: Type.String(),
  description: Type.String(),
  mitigation: Type.String(),
  humanApprovalRequired: Type.Boolean()
});

export type RiskSchemaType = Static<typeof RiskSchema>;

type _RiskSubtypeCheck = RiskSchemaType extends Risk ? true : never;
const _riskOk: _RiskSubtypeCheck = true;
void _riskOk;
