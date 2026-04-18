import type { RiskLevel, UUID } from "./plan.js";

export type PolicyDecisionType =
  | "approved"
  | "rejected"
  | "requires_human"
  | "budget_exceeded"
  | "scope_violation"
  | "retry_allowed"
  | "retry_denied";

export interface OperatingLimits {
  maxDelegationDepth: 2;
  maxConcurrentImplementersPerPhase: 4;
  maxConcurrentReviewersPerPhase: 2;
  maxReviewFixCyclesPerTask: 2;
  maxPlanningRevisions: 1;
  maxAutomaticPhaseReruns: 1;
  maxMergeRetryAttemptsPerTask: 2;
  maxFilesPerTaskSoft: 12;
  maxPackagesPerTaskSoft: 2;
  maxMigrationsPerTaskSoft: 1;
  maxWorktreeLifetimeHours: 24;
  maxBranchFanOutPerPhase: 6;
  maxUnresolvedHighSeverityFindings: 1;
  defaultTaskWallClockMinutes: 45;
}

export interface PolicyDecision {
  id: UUID;
  subjectType: "plan" | "task" | "merge" | "review";
  subjectId: UUID;
  riskLevel: RiskLevel;
  decision: PolicyDecisionType;
  reason: string;
  actor: "system" | "human";
  createdAt: string;
}

export interface TaskRoutingDecision {
  taskId: UUID;
  riskLevel: RiskLevel;
  canRunInParallel: boolean;
  requiresHumanApproval: boolean;
  reviewStrictness: "standard" | "elevated" | "critical";
  mergeMode: "automatic" | "approval_required";
}

export const DEFAULT_OPERATING_LIMITS: OperatingLimits = {
  maxDelegationDepth: 2,
  maxConcurrentImplementersPerPhase: 4,
  maxConcurrentReviewersPerPhase: 2,
  maxReviewFixCyclesPerTask: 2,
  maxPlanningRevisions: 1,
  maxAutomaticPhaseReruns: 1,
  maxMergeRetryAttemptsPerTask: 2,
  maxFilesPerTaskSoft: 12,
  maxPackagesPerTaskSoft: 2,
  maxMigrationsPerTaskSoft: 1,
  maxWorktreeLifetimeHours: 24,
  maxBranchFanOutPerPhase: 6,
  maxUnresolvedHighSeverityFindings: 1,
  defaultTaskWallClockMinutes: 45
};

