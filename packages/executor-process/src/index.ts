/**
 * @pm-go/executor-process
 *
 * Contract scaffolding for the process-backed executor. Exports:
 *   - ClaudeStreamEvent discriminated union (stream-json JSONL schema)
 *   - Process runner interface type aliases (structurally identical to their
 *     @pm-go/executor-claude counterparts so phase-1 implementors only need
 *     to import from this package)
 */

// ---------------------------------------------------------------------------
// JSONL event types
// ---------------------------------------------------------------------------

export type {
  ClaudeStreamEvent,
  ClaudeStreamSystemEvent,
  ClaudeStreamAssistantEvent,
  ClaudeStreamUserEvent,
  ClaudeStreamResultEvent,
  ContentBlock,
  MessageUsage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Process runner interfaces
// Each is a type alias of its @pm-go/executor-claude counterpart so that:
//   1. They are structurally assignable to the SDK-backed versions.
//   2. Consumers of executor-process need not import executor-claude.
// ---------------------------------------------------------------------------

export type {
  PlannerRunnerInput as ProcessPlannerRunnerInput,
  PlannerRunnerResult as ProcessPlannerRunnerResult,
  PlannerRunner as ProcessPlannerRunner,
  ImplementerRunnerInput as ProcessImplementerRunnerInput,
  ImplementerRunnerResult as ProcessImplementerRunnerResult,
  ImplementerRunner as ProcessImplementerRunner,
  ReviewerRunnerInput as ProcessReviewerRunnerInput,
  ReviewerRunnerResult as ProcessReviewerRunnerResult,
  ReviewerRunner as ProcessReviewerRunner,
  PhaseAuditorRunnerInput as ProcessPhaseAuditorRunnerInput,
  PhaseAuditorRunnerResult as ProcessPhaseAuditorRunnerResult,
  PhaseAuditorRunner as ProcessPhaseAuditorRunner,
  CompletionAuditorRunnerInput as ProcessCompletionAuditorRunnerInput,
  CompletionAuditorRunnerResult as ProcessCompletionAuditorRunnerResult,
  CompletionAuditorRunner as ProcessCompletionAuditorRunner,
} from "@pm-go/executor-claude";
