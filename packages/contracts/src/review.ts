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
