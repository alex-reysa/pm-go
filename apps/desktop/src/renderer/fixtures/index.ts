/**
 * Barrel for the M2 fixture module.
 *
 * Re-exports the {@link FIXTURE_BANNER_LABEL} banner constant and
 * every per-domain typed shape + dataset (happy / empty / error).
 *
 * Routes should prefer the named imports below over reaching into
 * individual files — the barrel is the M3-replacement boundary.
 * When M3 wires a domain to live API data, only the names
 * re-exported here will be touched, so consumer routes stay
 * import-stable.
 */

// Banner + shared fixture types.
export { FIXTURE_BANNER_LABEL } from "./banner.js";
export type { FixtureBannerLabel } from "./banner.js";
export type {
  ApprovalStatus,
  ApprovalSubject,
  ArtifactKind,
  CompletionAuditOutcome,
  EventKind,
  EventSeverity,
  FixtureApiError,
  FixtureDataset,
  FixtureId,
  IsoTimestamp,
  PhaseStatus,
  PlanStatus,
  ReleaseStatus,
  ReviewOutcome,
  RiskBand,
  TaskKind,
  TaskStatus,
} from "./types.js";

// Runs domain.
export type { RunSummary, RunsList } from "./runs.js";
export {
  runsHappyPath,
  runsEmptyState,
  runsErrorState,
} from "./runs.js";

// Plan domain.
export type { PlanCompletionAuditRef, PlanDetail } from "./plan.js";
export {
  planHappyPath,
  planEmptyState,
  planErrorState,
} from "./plan.js";

// Phases domain.
export type {
  PhaseAuditRef,
  PhaseMergeRunRef,
  PhaseSummary,
  PhasesList,
  TaskCountsByStatus,
} from "./phases.js";
export {
  phasesHappyPath,
  phasesEmptyState,
  phasesErrorState,
} from "./phases.js";

// Tasks domain.
export type {
  TaskActionAvailability,
  TaskAgentRunRef,
  TaskBudgetSpend,
  TaskDetail,
  TaskLeaseRef,
  TaskReviewReportRef,
  TaskSummary,
  TasksList,
} from "./tasks.js";
export {
  tasksHappyPath,
  tasksEmptyState,
  tasksErrorState,
  taskDetailHappyPath,
  taskDetailEmptyState,
  taskDetailErrorState,
} from "./tasks.js";

// Approvals domain.
export type { ApprovalQueueItem, ApprovalsList } from "./approvals.js";
export {
  approvalsHappyPath,
  approvalsEmptyState,
  approvalsErrorState,
} from "./approvals.js";

// Budget domain.
export type { BudgetPerTask, BudgetSnapshot } from "./budget.js";
export {
  budgetHappyPath,
  budgetEmptyState,
  budgetErrorState,
} from "./budget.js";

// Evidence domain.
export type {
  CompletionAuditFinding,
  CompletionChecklistRow,
  EvidenceArtifactContent,
  EvidenceBundleView,
} from "./evidence.js";
export {
  evidenceHappyPath,
  evidenceEmptyState,
  evidenceErrorState,
} from "./evidence.js";

// Artifacts domain.
export type {
  ArtifactDetail,
  ArtifactSummary,
  ArtifactsList,
} from "./artifacts.js";
export {
  artifactsHappyPath,
  artifactsEmptyState,
  artifactsErrorState,
  artifactDetailHappyPath,
  artifactDetailEmptyState,
  artifactDetailErrorState,
} from "./artifacts.js";

// Release domain.
export type { ReleaseView } from "./release.js";
export {
  releaseHappyPath,
  releaseEmptyState,
  releaseErrorState,
} from "./release.js";

// Events domain.
export type { EventItem, EventsList } from "./events.js";
export {
  eventsHappyPath,
  eventsEmptyState,
  eventsErrorState,
} from "./events.js";
