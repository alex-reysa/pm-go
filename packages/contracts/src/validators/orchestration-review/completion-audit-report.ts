import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { CompletionAuditReport } from "../../review.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { CompletionAuditSummarySchema } from "./completion-audit-summary.js";
import { CompletionChecklistItemSchema } from "./completion-checklist-item.js";
import { ReviewFindingSchema } from "./review-finding.js";

/**
 * Enumerated `CompletionAuditOutcome` values, mirrored from `review.ts`.
 */
export const CompletionAuditOutcomeSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("changes_requested"),
  Type.Literal("blocked")
]);

/**
 * 40-character lowercase hex Git SHA-1 commit hash.
 */
export const GitSha1Schema = Type.String({ pattern: "^[0-9a-f]{40}$" });

/**
 * TypeBox schema for `CompletionAuditReport`. Both `finalPhaseId` and
 * `mergeRunId` are required — the audit cites a specific phase and the
 * merge run that finalized it.
 */
export const CompletionAuditReportSchema = Type.Object({
  id: UuidSchema,
  planId: UuidSchema,
  finalPhaseId: UuidSchema,
  mergeRunId: UuidSchema,
  auditorRunId: UuidSchema,
  auditedHeadSha: GitSha1Schema,
  outcome: CompletionAuditOutcomeSchema,
  checklist: Type.Array(CompletionChecklistItemSchema),
  findings: Type.Array(ReviewFindingSchema),
  summary: CompletionAuditSummarySchema,
  createdAt: Iso8601Schema
});

export type CompletionAuditReportSchemaType = Static<
  typeof CompletionAuditReportSchema
>;

type _CompletionAuditReportSubtypeCheck =
  CompletionAuditReportSchemaType extends CompletionAuditReport ? true : never;
const _auditOk: _CompletionAuditReportSubtypeCheck = true;
void _auditOk;

/**
 * Runtime validator for `CompletionAuditReport`. Narrows `unknown` to
 * `CompletionAuditReport` on success.
 */
export function validateCompletionAuditReport(
  value: unknown
): value is CompletionAuditReport {
  return Value.Check(CompletionAuditReportSchema, value);
}
