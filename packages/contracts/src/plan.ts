export type UUID = string;

export type RiskLevel = "low" | "medium" | "high";
export type ReviewStrictness = "standard" | "elevated" | "critical";
export type PlanStatus =
  | "draft"
  | "auditing"
  | "approved"
  | "blocked"
  | "executing"
  | "completed"
  | "failed";
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "in_review"
  | "fixing"
  | "ready_to_merge"
  | "merged"
  | "blocked"
  | "failed";
export type TaskKind =
  | "foundation"
  | "implementation"
  | "review"
  | "integration"
  | "release";
export type PhaseStatus =
  | "pending"
  | "planning"
  | "executing"
  | "integrating"
  | "auditing"
  | "completed"
  | "blocked"
  | "failed";

export interface FileScope {
  includes: string[];
  excludes?: string[];
  packageScopes?: string[];
  maxFiles?: number;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  verificationCommands: string[];
  required: boolean;
}

export interface Risk {
  id: string;
  level: RiskLevel;
  title: string;
  description: string;
  mitigation: string;
  humanApprovalRequired: boolean;
}

export interface ReviewPolicy {
  required: boolean;
  strictness: ReviewStrictness;
  maxCycles: number;
  reviewerWriteAccess: false;
  stopOnHighSeverityCount: number;
}

export interface TaskBudget {
  maxWallClockMinutes: number;
  maxModelCostUsd?: number;
  maxPromptTokens?: number;
}

export interface Task {
  id: UUID;
  planId: UUID;
  phaseId: UUID;
  slug: string;
  title: string;
  summary: string;
  kind: TaskKind;
  status: TaskStatus;
  riskLevel: RiskLevel;
  fileScope: FileScope;
  acceptanceCriteria: AcceptanceCriterion[];
  testCommands: string[];
  budget: TaskBudget;
  reviewerPolicy: ReviewPolicy;
  requiresHumanApproval: boolean;
  maxReviewFixCycles: number;
  branchName?: string;
  worktreePath?: string;
}

export interface DependencyEdge {
  fromTaskId: UUID;
  toTaskId: UUID;
  reason: string;
  required: boolean;
}

export interface Plan {
  id: UUID;
  specDocumentId: UUID;
  repoSnapshotId: UUID;
  title: string;
  summary: string;
  status: PlanStatus;
  phases: Phase[];
  tasks: Task[];
  risks: Risk[];
  autoApproveLowRisk?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Phase {
  id: UUID;
  planId: UUID;
  index: number;
  title: string;
  summary: string;
  status: PhaseStatus;
  integrationBranch: string;
  baseSnapshotId: UUID;
  taskIds: UUID[];
  dependencyEdges: DependencyEdge[];
  mergeOrder: UUID[];
  phaseAuditReportId?: UUID;
  startedAt?: string;
  completedAt?: string;
}

