/**
 * Barrel export for Phase 6 workflow-event validators. First commit
 * carries only `WorkflowEvent` (discriminated union) +
 * `PhaseStatusChangedEvent`. Later Phase 6 commits add sibling
 * variants alongside the existing schemas here.
 */
export * from "./workflow-event.js";
