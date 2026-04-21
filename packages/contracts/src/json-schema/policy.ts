/**
 * JSON Schema exports for the Phase 7 policy contracts.
 *
 * TypeBox schemas ARE JSON Schema at runtime (same object shape), so
 * these re-exports give downstream consumers (the Claude Agent SDK
 * executor adapter, API route validators) a stable "this is JSON
 * Schema" surface without re-declaring the shape.
 */

export {
  ApprovalRequestSchema as ApprovalRequestJsonSchema,
  BudgetReportSchema as BudgetReportJsonSchema,
  RetryPolicyConfigSchema as RetryPolicyConfigJsonSchema,
} from "../validators/policy.js";
