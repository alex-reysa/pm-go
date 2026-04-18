import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { ReviewReport } from "../../review.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { ReviewFindingSchema } from "./review-finding.js";

/**
 * Enumerated `ReviewOutcome` values, mirrored from `review.ts`.
 */
export const ReviewOutcomeSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("changes_requested"),
  Type.Literal("blocked")
]);

/**
 * TypeBox schema for `ReviewReport`.
 */
export const ReviewReportSchema = Type.Object({
  id: UuidSchema,
  taskId: UuidSchema,
  reviewerRunId: UuidSchema,
  outcome: ReviewOutcomeSchema,
  findings: Type.Array(ReviewFindingSchema),
  createdAt: Iso8601Schema
}, { $id: "ReviewReport", additionalProperties: false });

export type ReviewReportSchemaType = Static<typeof ReviewReportSchema>;

type _ReviewReportSubtypeCheck = ReviewReportSchemaType extends ReviewReport
  ? true
  : never;
const _reportOk: _ReviewReportSubtypeCheck = true;
void _reportOk;

/**
 * Runtime validator for `ReviewReport`. Narrows `unknown` to `ReviewReport`
 * on success.
 */
export function validateReviewReport(value: unknown): value is ReviewReport {
  return Value.Check(ReviewReportSchema, value);
}
