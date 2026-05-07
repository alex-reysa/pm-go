import type { UUID } from "./plan.js";

/**
 * Stable identifier for a milestone within a `MilestoneManifest`. The
 * `m\d{2}-slug` shape is enforced at the schema level so manifests stay
 * sortable and operator-readable, and so plan rows that reference a
 * milestone never need to materialize the manifest's index.
 *
 * Examples: `"m01-acceptance-probe-loop"`, `"m07-release-checklist"`.
 */
export type MilestoneId = string;

/**
 * One unit of work in a Layer-A decomposition. Represents a slice of the
 * original spec scoped tightly enough that the planner can produce a
 * single phase-budget-respecting `Plan` for it.
 */
export interface Milestone {
  /** `m01-slug` style id; unique within the manifest. */
  id: MilestoneId;
  title: string;
  summary: string;
  /**
   * Section refs from the source spec (e.g. headings, anchors, line
   * ranges). These partition the spec across milestones — anything not
   * covered must appear in `MilestoneManifest.deferredScope`.
   */
  sourceSections: string[];
  exitCriteria: string[];
  /**
   * Planner hint: how many phases the eventual `Plan` for this milestone
   * is expected to need. Not load-bearing for downstream code; surfaced
   * to the operator during review and used by audits to flag manifests
   * whose milestones are obviously oversized.
   */
  expectedPhaseCount: number;
  /** IDs of milestones that must complete before this one. */
  dependsOn: MilestoneId[];
}

/**
 * Output of the decomposer agent. Lists the ordered milestones that
 * cover the spec along with any scope the decomposer chose to defer.
 *
 * Persisted as the `manifest jsonb` column on `spec_decompositions`
 * once `status` flips to `ready`.
 */
export interface MilestoneManifest {
  /** FK to `spec_documents.id` — must match the parent decomposition row. */
  specDocumentId: UUID;
  /** FK to `repo_snapshots.id` — must match the parent decomposition row. */
  repoSnapshotId: UUID;
  /**
   * Topologically ordered milestones. Each entry's `dependsOn` may only
   * reference earlier entries; the schema validator enforces this.
   */
  milestones: Milestone[];
  /**
   * Major spec scope the decomposer intentionally did not assign to a
   * milestone (typically deferred to a future spec). Surfaces in the
   * operator review so unhandled scope cannot silently drop on the floor.
   */
  deferredScope: string[];
}

/**
 * Lifecycle state of a `SpecDecomposition` row. `pending` is the initial
 * state; the workflow flips to `running` while the decomposer agent is
 * executing, then to `ready` (manifest populated) or `failed`
 * (`errorReason` populated) on terminal completion.
 */
export type SpecDecompositionStatus =
  | "pending"
  | "running"
  | "ready"
  | "failed";

/**
 * Persisted decomposition row. The `manifest` field is populated iff
 * `status === "ready"`; `errorReason` is populated iff `status === "failed"`.
 */
export interface SpecDecomposition {
  id: UUID;
  specDocumentId: UUID;
  repoSnapshotId: UUID;
  status: SpecDecompositionStatus;
  manifest?: MilestoneManifest;
  errorReason?: string;
  /**
   * Timestamp the API claimed the manifest lock for the first
   * `plan-first` request, ISO-8601. Once set, manifest edits are
   * rejected with 409 — provenance for any plan generated against
   * this decomposition stays anchored to the manifest the workflow
   * actually planned against.
   */
  planFirstStartedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Optional context piped through `SpecToPlanWorkflowInput` when the plan
 * is being generated for a single milestone (rather than the full spec).
 * Lets the planner narrow its prompt to just the relevant `sourceSections`
 * and `exitCriteria`, and lets plan provenance round-trip back to the
 * decomposition row that spawned the plan.
 */
export interface MilestoneContext {
  decompositionId: UUID;
  milestoneId: MilestoneId;
  manifest: MilestoneManifest;
}
