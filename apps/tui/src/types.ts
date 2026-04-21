import type { UUID } from "@pm-go/contracts";

/**
 * TUI-local route shape. The shell switches on `name`; screens own
 * their own selection state. `task` is the fullscreen task drawer
 * (not a modal — it's a navigation destination). `release` is the
 * completion-audit + artifact-list view.
 */
export type Route =
  | { name: "plans" }
  | { name: "plan"; planId: UUID }
  | { name: "task"; planId: UUID; taskId: UUID }
  | { name: "release"; planId: UUID }
  // Phase 7 — operator approvals screen.
  | { name: "approvals"; planId: UUID };

/**
 * Actions that the confirm modal gates before firing against the API.
 * Each variant carries whatever the describe/execute layer needs —
 * e.g. run-task needs the taskId + a label (rendered in the modal).
 * The plan-detail / release-screen action dispatchers build these
 * from cursor state; the app shell resolves them via `api.*`.
 */
export type PendingAction =
  | { kind: "run-task"; taskId: UUID; label: string }
  | { kind: "review-task"; taskId: UUID; label: string }
  | { kind: "fix-task"; taskId: UUID; label: string }
  | { kind: "integrate-phase"; phaseId: UUID; label: string }
  | { kind: "audit-phase"; phaseId: UUID; label: string }
  | { kind: "complete-plan"; planId: UUID; label: string }
  | { kind: "release-plan"; planId: UUID; label: string }
  // Phase 7 — operator approve flips the matching approval_requests row.
  | { kind: "approve-task"; taskId: UUID; label: string }
  | { kind: "approve-plan"; planId: UUID; label: string };

/**
 * Plan-detail cursor position, lifted to the app shell so it survives
 * the confirm-modal unmount cycle. The two variants mirror the two
 * selectable row kinds on plan-detail (`release` row + task row); the
 * cursor/render code in the screen derives an index from this.
 */
export type PlanSelection =
  | { kind: "release" }
  | { kind: "task"; taskId: UUID };
