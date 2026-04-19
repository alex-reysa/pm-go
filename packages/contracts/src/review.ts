import type { UUID } from "./plan.js";

export type FindingSeverity = "low" | "medium" | "high";
export type ReviewOutcome = "pass" | "changes_requested" | "blocked";
export type ReviewCheckStatus = "passed" | "failed" | "not_verified" | "waived";
export type CompletionAuditOutcome = "pass" | "changes_requested" | "blocked";

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  summary: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  confidence: number;
  suggestedFixDirection: string;
}

export interface ReviewReport {
  id: UUID;
  taskId: UUID;
  reviewerRunId: UUID;
  outcome: ReviewOutcome;
  findings: ReviewFinding[];
  createdAt: string;
}

/**
 * Persisted ReviewReport shape — the wire `ReviewReport` plus the
 * host-stamped commit range and cycle number. These three fields live
 * on the `review_reports` table columns (reviewed_base_sha,
 * reviewed_head_sha, cycle_number) so a later reader can reconstruct
 * the exact audited commit window after more fix cycles land on the
 * same task branch. Phase auditors and completion auditors consume
 * this enriched shape in their evidence bundles — passing bare
 * `ReviewReport[]` through the audit boundary would drop the commit
 * provenance that Phase 4 hardening deliberately added.
 *
 * This is the canonical "durable review report" type used everywhere
 * outside the wire protocol between reviewer agent and host. The
 * `@pm-go/temporal-activities` package re-exports it under the same
 * name for back-compat with Phase 4 call sites.
 */
export type StoredReviewReport = ReviewReport & {
  cycleNumber: number;
  reviewedBaseSha: string;
  reviewedHeadSha: string;
};

export interface CompletionChecklistItem {
  id: string;
  title: string;
  status: ReviewCheckStatus;
  evidenceArtifactIds: UUID[];
  relatedTaskIds?: UUID[];
  notes?: string;
}

export interface CompletionAuditSummary {
  acceptanceCriteriaPassed: string[];
  acceptanceCriteriaMissing: string[];
  openFindingIds: string[];
  unresolvedPolicyDecisionIds: UUID[];
}

export interface CompletionAuditReport {
  id: UUID;
  planId: UUID;
  finalPhaseId: UUID;
  mergeRunId: UUID;
  auditorRunId: UUID;
  auditedHeadSha: string;
  outcome: CompletionAuditOutcome;
  checklist: CompletionChecklistItem[];
  findings: ReviewFinding[];
  summary: CompletionAuditSummary;
  createdAt: string;
}

export type PhaseAuditOutcome = "pass" | "changes_requested" | "blocked";

export interface PhaseAuditReport {
  id: UUID;
  phaseId: UUID;
  planId: UUID;
  mergeRunId: UUID;
  auditorRunId: UUID;
  mergedHeadSha: string;
  outcome: PhaseAuditOutcome;
  checklist: CompletionChecklistItem[];
  findings: ReviewFinding[];
  summary: string;
  createdAt: string;
}
