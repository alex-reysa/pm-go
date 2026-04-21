import type { Phase, Plan, Task } from "@pm-go/contracts";

import type { PlanDetail } from "./api.js";

/**
 * Client-side precondition gates. These mirror the *primary* 409 rule
 * the server enforces for each operator action (see
 * `apps/api/src/routes/tasks.ts`, `phases.ts`, `plans.ts`). The TUI
 * dims the chord + suppresses the confirm modal when a gate says no,
 * but the server is still authoritative — a stale cache may let a
 * disallowed action through, in which case the server's 409 + our
 * `ErrorBanner` catch the miss.
 *
 * Each gate returns a discriminated union so the footer + hover tips
 * can render the reason without an extra lookup table.
 */
export type Gate = { ok: true } | { ok: false; reason: string };

/** `POST /tasks/:id/run` — phase must be executing (tasks.ts:135). */
export function canRunTask(phase: Phase, task: Task): Gate {
  if (phase.status !== "executing") {
    return {
      ok: false,
      reason: `phase is '${phase.status}'; run requires 'executing'`,
    };
  }
  if (task.status === "merged" || task.status === "ready_to_merge") {
    return {
      ok: false,
      reason: `task already '${task.status}'`,
    };
  }
  return { ok: true };
}

/**
 * `POST /tasks/:id/review` — server has no precondition, but firing
 * review on a task that isn't in review is meaningless. UX gate only.
 */
export function canReviewTask(task: Task): Gate {
  if (task.status !== "in_review") {
    return {
      ok: false,
      reason: `task is '${task.status}'; review targets 'in_review' tasks`,
    };
  }
  return { ok: true };
}

/**
 * `POST /tasks/:id/fix` — task must be in `fixing` (tasks.ts:419).
 * The server also checks the latest review report outcome
 * (tasks.ts:443); the TUI relies on the server for that deeper gate.
 */
export function canFixTask(task: Task): Gate {
  if (task.status !== "fixing") {
    return {
      ok: false,
      reason: `task is '${task.status}'; fix requires 'fixing'`,
    };
  }
  return { ok: true };
}

/**
 * `POST /phases/:id/integrate` — phase executing/integrating AND all
 * tasks ready_to_merge/merged (phases.ts:105, 121).
 */
export function canIntegratePhase(phase: Phase, tasks: Task[]): Gate {
  if (phase.status !== "executing" && phase.status !== "integrating") {
    return {
      ok: false,
      reason: `phase is '${phase.status}'; integrate requires 'executing' or 'integrating'`,
    };
  }
  const unready = tasks.filter(
    (t) => t.status !== "ready_to_merge" && t.status !== "merged",
  );
  if (unready.length > 0) {
    return {
      ok: false,
      reason: `${unready.length} task(s) not ready for merge`,
    };
  }
  return { ok: true };
}

/** `POST /phases/:id/audit` — phase must be auditing (phases.ts:185). */
export function canAuditPhase(phase: Phase): Gate {
  if (phase.status !== "auditing") {
    return {
      ok: false,
      reason: `phase is '${phase.status}'; audit requires 'auditing'`,
    };
  }
  return { ok: true };
}

/**
 * `POST /plans/:id/complete` — every phase must be completed
 * (plans.ts:244). Server also checks the final phase's merge_run
 * (plans.ts:262); unlikely to diverge from phase.status=completed.
 */
export function canCompletePlan(plan: Plan): Gate {
  if (plan.phases.length === 0) {
    return { ok: false, reason: "plan has no phases" };
  }
  const notDone = plan.phases.filter((p) => p.status !== "completed");
  if (notDone.length > 0) {
    return {
      ok: false,
      reason: `${notDone.length} phase(s) not yet completed`,
    };
  }
  return { ok: true };
}

/**
 * `POST /plans/:id/release` — plan must have a completion audit that
 * passed (plans.ts:331, 353). The API surfaces both signals via
 * `latestCompletionAudit` on `PlanDetail`; a null value means
 * complete hasn't run yet, a non-pass outcome means release is
 * refused.
 */
export function canReleasePlan(detail: PlanDetail): Gate {
  if (detail.latestCompletionAudit === null) {
    return {
      ok: false,
      reason: "plan has no completion audit; run complete first",
    };
  }
  if (detail.latestCompletionAudit.outcome !== "pass") {
    return {
      ok: false,
      reason: `audit outcome is '${detail.latestCompletionAudit.outcome}'; release requires 'pass'`,
    };
  }
  return { ok: true };
}
