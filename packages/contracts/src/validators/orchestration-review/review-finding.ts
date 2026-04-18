import { Type, type Static } from "@sinclair/typebox";

import type { ReviewFinding } from "../../review.js";

/**
 * Enumerated `FindingSeverity` values, mirrored from `review.ts`.
 */
export const FindingSeveritySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high")
]);

/**
 * TypeBox schema for `ReviewFinding`. Reused by both `ReviewReport`
 * and `CompletionAuditReport`.
 */
export const ReviewFindingSchema = Type.Object({
  id: Type.String(),
  severity: FindingSeveritySchema,
  title: Type.String(),
  summary: Type.String(),
  filePath: Type.String(),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  endLine: Type.Optional(Type.Integer({ minimum: 1 })),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  suggestedFixDirection: Type.String()
});

export type ReviewFindingSchemaType = Static<typeof ReviewFindingSchema>;

type _ReviewFindingSubtypeCheck = ReviewFindingSchemaType extends ReviewFinding
  ? true
  : never;
const _findingOk: _ReviewFindingSubtypeCheck = true;
void _findingOk;
