import { Type, type Static } from "@sinclair/typebox";

import type { CompletionAuditSummary } from "../../review.js";
import { UuidSchema } from "../../shared/schema.js";

/**
 * TypeBox schema for `CompletionAuditSummary`. Contains cross-referenced
 * IDs from acceptance criteria, findings, and policy decisions.
 */
export const CompletionAuditSummarySchema = Type.Object({
  acceptanceCriteriaPassed: Type.Array(Type.String()),
  acceptanceCriteriaMissing: Type.Array(Type.String()),
  openFindingIds: Type.Array(Type.String()),
  unresolvedPolicyDecisionIds: Type.Array(UuidSchema)
});

export type CompletionAuditSummarySchemaType = Static<
  typeof CompletionAuditSummarySchema
>;

type _SummarySubtypeCheck =
  CompletionAuditSummarySchemaType extends CompletionAuditSummary
    ? true
    : never;
const _summaryOk: _SummarySubtypeCheck = true;
void _summaryOk;
