/**
 * Phase 7 Worker 1 sub-barrel.
 *
 * Re-exports the additive types that `packages/policy-engine/` needs
 * downstream (approval requests, budget reports, retry/stop decisions)
 * so that Worker 4 can reconcile the root `packages/contracts/src/index.ts`
 * once — after both Wave-1 lanes land — without three-way conflicts
 * against this worker's policy changes and Worker 2's observability
 * changes.
 *
 * Nothing new lives in this file; it is pure re-export plumbing.
 * The root `packages/contracts/src/index.ts` does **not** import from
 * here in Worker 1's commits. Worker 4 inlines `export * from
 * "./policy-exports.js"` (and the mirror observability-exports barrel)
 * during integration.
 */

export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRiskBand,
  ApprovalStatus,
  ApprovalSubject,
  BudgetDecision,
  BudgetOverrun,
  BudgetReport,
  BudgetTaskBreakdown,
  RetryDecision,
  RetryPolicyConfig,
  StopDecision,
  StopReason,
} from "./policy.js";

export {
  ApprovalRequestSchema,
  BudgetReportSchema,
  BudgetTaskBreakdownSchema,
  RetryPolicyConfigSchema,
  validateApprovalRequest,
  validateBudgetReport,
  validateRetryPolicyConfig,
} from "./validators/policy.js";

export {
  ApprovalRequestJsonSchema,
  BudgetReportJsonSchema,
  RetryPolicyConfigJsonSchema,
} from "./json-schema/policy.js";
