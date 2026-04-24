export { buildBranchName } from "./branch-naming.js";
export { createLease } from "./create-lease.js";
export type { CreateLeaseInput } from "./create-lease.js";
export { releaseLease } from "./release-lease.js";
export type { ReleaseLeaseInput } from "./release-lease.js";
export { diffScope, matchesPattern } from "./diff-scope.js";
export type { DiffScopeInput, DiffScopeResult } from "./diff-scope.js";
export { detectDirty } from "./detect-dirty.js";
export type { DetectDirtyInput } from "./detect-dirty.js";
export { revokeExpiredLease } from "./revoke-expired-lease.js";
export type {
  RevokeExpiredLeaseInput,
  RevokeExpiredLeaseResult,
} from "./revoke-expired-lease.js";
export {
  WorktreeManagerError,
  type WorktreeManagerErrorCode,
} from "./errors.js";
export type {
  BranchNamingInput,
  DirtyReport,
} from "./types.js";

// Phase 5 — integration worktree + merge primitives.
export { createIntegrationLease } from "./create-integration-lease.js";
export type { CreateIntegrationLeaseInput } from "./create-integration-lease.js";
export { attemptIntegrationMerge } from "./attempt-integration-merge.js";
export type {
  AttemptIntegrationMergeInput,
  AttemptIntegrationMergeResult,
} from "./attempt-integration-merge.js";
export { abortIntegrationMerge } from "./abort-integration-merge.js";
export type { AbortIntegrationMergeInput } from "./abort-integration-merge.js";
export { fastForwardMainViaUpdateRef } from "./fast-forward-main.js";
export type {
  FastForwardMainInput,
  FastForwardMainResult,
} from "./fast-forward-main.js";
