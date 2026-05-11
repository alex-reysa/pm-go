/**
 * Shared fixture types for the desktop renderer mock data.
 *
 * These types deliberately mirror the read-model shapes documented
 * in `docs/desktop/05-api-integration.md`. The fixture module
 * intentionally owns its OWN typed surface — it does not import
 * from `@pm-go/contracts` or any other shared package — so that
 * M3 can swap each domain dataset for a live-API import with a
 * single import-site change, without forcing M2 routes to consume
 * a different (richer, less stable) contract shape today.
 *
 * Two design choices are worth calling out:
 *
 *   1. Status-like enums are encoded as string literal unions
 *      rather than `enum` declarations. Unions interop better with
 *      JSON-shaped fixture data and avoid the dual-namespace
 *      footgun that `enum` introduces under `isolatedModules`.
 *
 *   2. Every domain dataset is wrapped in a {@link FixtureDataset}
 *      envelope. The envelope carries a discriminator (`state`),
 *      a human-readable `label` for the banner area, and the
 *      data itself. Error-state datasets additionally carry a
 *      {@link FixtureApiError} so the route can demo what an
 *      `ApiError` rendering looks like without dragging the real
 *      ApiError class into the renderer at M2.
 */

/** Opaque string identifier returned by the API. */
export type FixtureId = string;

/** ISO-8601 timestamp; the API serializes everything as a string. */
export type IsoTimestamp = string;

/**
 * Plan-level workflow status. Names track the state machine
 * described in `docs/desktop/05-api-integration.md` action-gating
 * matrix; the strings are illustrative for fixture rendering, not
 * authoritative for any actual server-side state-machine logic.
 */
export type PlanStatus =
  | "draft"
  | "executing"
  | "auditing"
  | "completed"
  | "released"
  | "blocked"
  | "failed";

/** Phase-level workflow status. */
export type PhaseStatus =
  | "pending"
  | "executing"
  | "integrating"
  | "auditing"
  | "completed"
  | "blocked"
  | "failed";

/** Task-level workflow status. */
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

/** Risk band used for fixtures and approval rows. */
export type RiskBand = "low" | "medium" | "high";

/** Task kind taxonomy used in the planner. */
export type TaskKind =
  | "foundation"
  | "feature"
  | "fix"
  | "refactor"
  | "chore"
  | "docs"
  | "test";

/** Approval-row lifecycle state. */
export type ApprovalStatus = "pending" | "approved" | "skipped" | "rejected";

/** Approval scope: which subject the row gates. */
export type ApprovalSubject = "task" | "phase" | "plan";

/** Review outcome on a single task cycle. */
export type ReviewOutcome =
  | "pending"
  | "approved"
  | "changes_requested"
  | "overridden";

/** Artifact taxonomy used for evidence and release surfaces. */
export type ArtifactKind =
  | "pr_summary"
  | "completion_evidence_bundle"
  | "phase_audit_report"
  | "review_report"
  | "completion_audit_report"
  | "merge_run_summary"
  | "task_diff"
  | "other";

/** SSE / events `kind` values currently recognized by the TUI / Desktop. */
export type EventKind =
  | "phase_status_changed"
  | "task_status_changed"
  | "artifact_persisted";

/** Severity ranking for cockpit event-drawer rendering. */
export type EventSeverity = "info" | "warn" | "error";

/** Release lifecycle as observed by the renderer. */
export type ReleaseStatus =
  | "idle"
  | "ready"
  | "in_progress"
  | "released"
  | "failed";

/** Completion-audit outcome. */
export type CompletionAuditOutcome = "pass" | "fail" | "blocked";

/**
 * Discriminated error shape attached to error-state fixtures.
 *
 * Mirrors the `ApiError` documented in 05-api-integration.md
 * without dragging a runtime class into the renderer. M3 will
 * replace fixture error rendering with the real `ApiError`
 * pipeline; the shape is intentionally compatible.
 */
export interface FixtureApiError {
  /** HTTP status (or `0` for renderer-side network failures). */
  status: number;
  /** Short message intended for inline display. */
  message: string;
  /**
   * Preserved structured body, mirroring API failure envelopes
   * like `{ error, blockedPhaseIds }`. Optional because some
   * failures are pure network errors with no body.
   */
  body?: Record<string, unknown>;
  /** Server-emitted request id if available; future-friendly. */
  requestId?: string;
}

/**
 * Envelope wrapping every domain dataset. Routes consuming fixtures
 * branch on `state` to pick the right rendering path:
 *
 *   - `happy` → render the populated view.
 *   - `empty` → render the empty-state message.
 *   - `error` → render the error surface AND keep surrounding
 *     navigation/context visible. The route is given partial /
 *     stale `data` it can keep on screen alongside the error.
 *
 * The `label` is a short human-readable string the M2 banner area
 * can append to {@link FIXTURE_BANNER_LABEL} — for example
 * `"fixture: mocked — replace in M3 · runs · error 503"`. Routes
 * are not required to surface `label` but it keeps fixture intent
 * obvious in screenshot bug reports.
 */
export type FixtureDataset<T> =
  | { state: "happy"; label: string; data: T }
  | { state: "empty"; label: string; data: T }
  | { state: "error"; label: string; data: T; error: FixtureApiError };
