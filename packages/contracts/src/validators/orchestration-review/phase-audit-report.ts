import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { PhaseAuditReport } from "../../review.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { CompletionChecklistItemSchema } from "./completion-checklist-item.js";
import { GitSha1Schema } from "./completion-audit-report.js";
import { ReviewFindingSchema } from "./review-finding.js";

/**
 * Enumerated `PhaseAuditOutcome` values, mirrored from `review.ts`.
 */
export const PhaseAuditOutcomeSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("changes_requested"),
  Type.Literal("blocked"),
]);

/**
 * TypeBox schema for `PhaseAuditReport`. Both `mergeRunId` and
 * `mergedHeadSha` are required — the audit must cite the exact MergeRun
 * that produced the audited head.
 */
export const PhaseAuditReportSchema = Type.Object(
  {
    id: UuidSchema,
    phaseId: UuidSchema,
    planId: UuidSchema,
    mergeRunId: UuidSchema,
    auditorRunId: UuidSchema,
    mergedHeadSha: GitSha1Schema,
    outcome: PhaseAuditOutcomeSchema,
    checklist: Type.Array(CompletionChecklistItemSchema),
    findings: Type.Array(ReviewFindingSchema),
    summary: Type.String(),
    createdAt: Iso8601Schema,
  },
  { $id: "PhaseAuditReport", additionalProperties: false },
);

export type PhaseAuditReportSchemaType = Static<typeof PhaseAuditReportSchema>;

type _PhaseAuditReportSubtypeCheck = PhaseAuditReportSchemaType extends PhaseAuditReport
  ? true
  : never;
const _phaseAuditOk: _PhaseAuditReportSubtypeCheck = true;
void _phaseAuditOk;

/**
 * Runtime validator for `PhaseAuditReport`. Narrows `unknown` to
 * `PhaseAuditReport` on success.
 */
export function validatePhaseAuditReport(
  value: unknown,
): value is PhaseAuditReport {
  return Value.Check(PhaseAuditReportSchema, value);
}
