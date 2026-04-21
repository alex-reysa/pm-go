import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type {
  ApprovalRequest,
  BudgetReport,
  BudgetTaskBreakdown,
  RetryPolicyConfig,
} from "../policy.js";
import { UuidSchema, Iso8601Schema } from "../shared/schema.js";

// Re-use the orchestration-review lane's format registry (uuid + date-time).
// The side-effect import below registers formats idempotently; importing it
// here keeps the Phase 7 validators self-sufficient regardless of import
// order in consumer code.
import "./orchestration-review/formats.js";

/**
 * TypeBox schema literals shared across the policy-engine validators.
 */
export const ApprovalSubjectSchema = Type.Union([
  Type.Literal("plan"),
  Type.Literal("task"),
]);

export const ApprovalRiskBandSchema = Type.Union([
  Type.Literal("high"),
  Type.Literal("catastrophic"),
]);

export const ApprovalStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("approved"),
  Type.Literal("rejected"),
]);

/**
 * TypeBox schema for `ApprovalRequest`. Backs the `approval_requests`
 * table. The `taskId` field is required-when-`subject === "task"`; the
 * cross-field rule is enforced in application code and by the DB CHECK
 * on the migration, not in the JSON schema.
 */
export const ApprovalRequestSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    taskId: Type.Optional(UuidSchema),
    subject: ApprovalSubjectSchema,
    riskBand: ApprovalRiskBandSchema,
    status: ApprovalStatusSchema,
    requestedBy: Type.Optional(Type.String({ minLength: 1 })),
    approvedBy: Type.Optional(Type.String({ minLength: 1 })),
    requestedAt: Iso8601Schema,
    decidedAt: Type.Optional(Iso8601Schema),
    reason: Type.Optional(Type.String()),
  },
  { $id: "ApprovalRequest", additionalProperties: false },
);

export type ApprovalRequestSchemaType = Static<typeof ApprovalRequestSchema>;

type _ApprovalRequestSubtypeCheck = ApprovalRequestSchemaType extends ApprovalRequest
  ? true
  : never;
const _approvalOk: _ApprovalRequestSubtypeCheck = true;
void _approvalOk;

/**
 * Runtime validator for `ApprovalRequest`. Narrows `unknown` on success.
 */
export function validateApprovalRequest(value: unknown): value is ApprovalRequest {
  return Value.Check(ApprovalRequestSchema, value);
}

export const BudgetTaskBreakdownSchema = Type.Object(
  {
    taskId: UuidSchema,
    totalUsd: Type.Number({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    totalWallClockMinutes: Type.Number({ minimum: 0 }),
  },
  { $id: "BudgetTaskBreakdown", additionalProperties: false },
);

export type BudgetTaskBreakdownSchemaType = Static<typeof BudgetTaskBreakdownSchema>;

type _BudgetTaskBreakdownSubtypeCheck =
  BudgetTaskBreakdownSchemaType extends BudgetTaskBreakdown ? true : never;
const _breakdownOk: _BudgetTaskBreakdownSubtypeCheck = true;
void _breakdownOk;

/**
 * TypeBox schema for `BudgetReport`. Backs the `budget_reports` table.
 */
export const BudgetReportSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    totalUsd: Type.Number({ minimum: 0 }),
    totalTokens: Type.Integer({ minimum: 0 }),
    totalWallClockMinutes: Type.Number({ minimum: 0 }),
    perTaskBreakdown: Type.Array(BudgetTaskBreakdownSchema),
    generatedAt: Iso8601Schema,
  },
  { $id: "BudgetReport", additionalProperties: false },
);

export type BudgetReportSchemaType = Static<typeof BudgetReportSchema>;

type _BudgetReportSubtypeCheck = BudgetReportSchemaType extends BudgetReport
  ? true
  : never;
const _reportOk: _BudgetReportSubtypeCheck = true;
void _reportOk;

/**
 * Runtime validator for `BudgetReport`.
 */
export function validateBudgetReport(value: unknown): value is BudgetReport {
  return Value.Check(BudgetReportSchema, value);
}

/**
 * TypeBox schema for `RetryPolicyConfig`. Declarative, SDK-neutral.
 */
export const RetryPolicyConfigSchema = Type.Object(
  {
    workflowName: Type.String({ minLength: 1 }),
    initialDelayMs: Type.Integer({ minimum: 0 }),
    maxDelayMs: Type.Integer({ minimum: 0 }),
    backoffMultiplier: Type.Number({ minimum: 1 }),
    maxAttempts: Type.Integer({ minimum: 1 }),
    nonRetryableErrorNames: Type.Optional(Type.Array(Type.String())),
  },
  { $id: "RetryPolicyConfig", additionalProperties: false },
);

export type RetryPolicyConfigSchemaType = Static<typeof RetryPolicyConfigSchema>;

/**
 * Runtime validator for `RetryPolicyConfig`.
 */
export function validateRetryPolicyConfig(
  value: unknown,
): value is RetryPolicyConfig {
  return Value.Check(RetryPolicyConfigSchema, value);
}
