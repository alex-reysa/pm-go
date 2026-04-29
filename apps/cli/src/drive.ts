/**
 * `pm-go drive` — client-side state-machine driver.
 *
 * Takes a plan from "submitted" to "released" by issuing the right
 * sequence of API calls and pausing only when human approval is
 * needed. Pairs with `pm-go run` (the supervisor that boots the
 * stack); slice 5 will combine the two into `pm-go implement`.
 *
 * Per phase, in order:
 *   1. For each task in mergeOrder:
 *        - pending/ready  → POST /tasks/:id/run, wait for in_review
 *        - in_review      → POST /tasks/:id/review
 *          - changes_requested → POST /tasks/:id/fix, wait, re-review
 *          - pass              → advance
 *          - blocked           → log + bail (use override-review)
 *   2. POST /phases/:id/integrate, wait
 *   3. Approve any pending approvals (--approve all|none|interactive)
 *   4. POST /phases/:id/audit, wait
 *      - blocked / changes_requested → log + bail (use override-audit)
 *
 * Once every phase is `completed`:
 *   5. POST /plans/:id/complete, poll for latestCompletionAudit
 *   6. POST /plans/:id/release
 *
 * All effectful I/O (fetch, sleep, log, prompt) lives behind
 * `DriveDeps` so unit tests can drive the entire state machine in
 * microseconds with mocked HTTP responses.
 */

import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from './lib/api-client.js'
import { waitFor } from './lib/wait-for.js'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export type ApproveMode = 'all' | 'none' | 'interactive'

export interface DriveOptions {
  /** UUID of the plan to drive. */
  planId: string
  /** API base URL (e.g. `http://localhost:3001`). */
  apiUrl: string
  /** Approval policy. */
  approve: ApproveMode
}

export interface ParsedDriveArgv {
  ok: true
  options: DriveOptions
}

export interface DriveArgvError {
  ok: false
  error: string
}

const DEFAULT_API_PORT = 3001

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse `pm-go drive` argv into a typed DriveOptions. Mirrors the
 * tagged-union style of `parseRunArgv` so callers can render a friendly
 * usage error without throwing.
 */
export function parseDriveArgv(
  argv: readonly string[],
): ParsedDriveArgv | DriveArgvError {
  let planId: string | undefined
  let port: number | undefined
  let apiUrl: string | undefined
  let approve: ApproveMode = 'all'

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--plan':
        if (!value) return { ok: false, error: `${flag} requires a UUID` }
        if (!UUID_RE.test(value)) {
          return { ok: false, error: `${flag} must be a UUID` }
        }
        planId = value
        i++
        break
      case '--port':
      case '-p': {
        if (!value) return { ok: false, error: `${flag} requires a number` }
        const n = Number.parseInt(value, 10)
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return { ok: false, error: `${flag} must be an integer 1..65535` }
        }
        port = n
        i++
        break
      }
      case '--api-url':
        if (!value) return { ok: false, error: `${flag} requires a URL` }
        apiUrl = value.replace(/\/+$/, '')
        i++
        break
      case '--approve': {
        if (!value) return { ok: false, error: `${flag} requires a value` }
        const allowed = ['all', 'none', 'interactive'] as const
        if (!allowed.includes(value as (typeof allowed)[number])) {
          return {
            ok: false,
            error: `${flag} must be one of ${allowed.join(', ')}`,
          }
        }
        approve = value as ApproveMode
        i++
        break
      }
      case '--help':
      case '-h':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }

  if (!planId) {
    return { ok: false, error: '--plan <uuid> is required' }
  }

  // --port and --api-url cooperate: --api-url wins outright; otherwise
  // build a default localhost URL using --port (default 3001).
  const resolvedUrl =
    apiUrl ?? `http://localhost:${port ?? DEFAULT_API_PORT}`

  return {
    ok: true,
    options: { planId, apiUrl: resolvedUrl, approve },
  }
}

// ---------------------------------------------------------------------------
// Plan / task / phase shapes (a narrow read model — we don't import the
// full @pm-go/contracts here to keep the CLI dependency surface minimal).
// ---------------------------------------------------------------------------

export type DrivenTaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'in_review'
  | 'fixing'
  | 'ready_to_merge'
  | 'merged'
  | 'blocked'
  | 'failed'

export type DrivenPhaseStatus =
  | 'pending'
  | 'planning'
  | 'executing'
  | 'integrating'
  | 'auditing'
  | 'completed'
  | 'blocked'
  | 'failed'

export interface DrivenTask {
  id: string
  phaseId: string
  status: DrivenTaskStatus
  title: string
}

export interface DrivenPhase {
  id: string
  index: number
  title: string
  status: DrivenPhaseStatus
  mergeOrder: string[]
}

export interface DrivenPlan {
  id: string
  status: string
  phases: DrivenPhase[]
  tasks: DrivenTask[]
}

export interface CompletionAuditSummary {
  outcome: 'pass' | 'changes_requested' | 'blocked'
}

export interface PlanResponse {
  plan: DrivenPlan
  latestCompletionAudit: CompletionAuditSummary | null
}

export interface TaskDetailResponse {
  task: { id: string; status: DrivenTaskStatus }
  latestReviewReport: {
    outcome: 'pass' | 'changes_requested' | 'blocked'
  } | null
}

export interface ApprovalRow {
  id: string
  subject: 'task' | 'plan'
  status: 'pending' | 'approved' | 'rejected'
  taskId: string | null
  riskBand?: string
}

// ---------------------------------------------------------------------------
// Side-effect deps (injected for tests)
// ---------------------------------------------------------------------------

export interface DriveDeps {
  fetch: typeof globalThis.fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  errLog: (line: string) => void
  /**
   * Interactive prompt — used only when --approve interactive. Should
   * return `true` to approve, `false` to skip. Tests inject a stub.
   */
  prompt: (question: string) => Promise<boolean>
}

// ---------------------------------------------------------------------------
// Tunable timing constants (small for tests; the real waitFor is mocked
// out at unit-test time so production values still get exercised in CI).
// ---------------------------------------------------------------------------

export interface DriveTimings {
  pollIntervalMs: number
  taskRunTimeoutMs: number
  taskReviewTimeoutMs: number
  taskFixTimeoutMs: number
  phaseIntegrateTimeoutMs: number
  phaseAuditTimeoutMs: number
  planCompleteTimeoutMs: number
}

export const DEFAULT_TIMINGS: DriveTimings = {
  pollIntervalMs: 1_000,
  // Bumped to align with the worker's 60m runImplementer / 30m
  // runReviewer activity StartToClose budgets. With the new $15
  // implementer / $5 reviewer caps, large tasks routinely take 30-50
  // minutes; the prior 15m drive timeout abandoned a still-running task.
  taskRunTimeoutMs: 75 * 60_000,
  taskReviewTimeoutMs: 35 * 60_000,
  taskFixTimeoutMs: 75 * 60_000,
  phaseIntegrateTimeoutMs: 20 * 60_000,
  phaseAuditTimeoutMs: 35 * 60_000,
  planCompleteTimeoutMs: 35 * 60_000,
}

// ---------------------------------------------------------------------------
// HTTP helpers (centralised so tests assert against one mock surface).
// ---------------------------------------------------------------------------

async function getPlan(
  opts: DriveOptions,
  deps: DriveDeps,
): Promise<PlanResponse> {
  const res = await deps.fetch(`${opts.apiUrl}/plans/${opts.planId}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /plans/${opts.planId} → ${res.status}: ${text}`)
  }
  return (await res.json()) as PlanResponse
}

async function getTaskDetail(
  opts: DriveOptions,
  taskId: string,
  deps: DriveDeps,
): Promise<TaskDetailResponse> {
  const res = await deps.fetch(`${opts.apiUrl}/tasks/${taskId}`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /tasks/${taskId} → ${res.status}: ${text}`)
  }
  return (await res.json()) as TaskDetailResponse
}

async function postEmpty(
  url: string,
  deps: DriveDeps,
  body?: unknown,
): Promise<unknown> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${url} → ${res.status}: ${text}`)
  }
  return res.json().catch(() => ({}))
}

async function listApprovals(
  opts: DriveOptions,
  deps: DriveDeps,
): Promise<ApprovalRow[]> {
  const res = await deps.fetch(
    `${opts.apiUrl}/approvals?planId=${opts.planId}`,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GET /approvals → ${res.status}: ${text}`)
  }
  const body = (await res.json()) as { approvals: ApprovalRow[] }
  return body.approvals ?? []
}

// ---------------------------------------------------------------------------
// Polling helpers — wrap waitFor() with a more legible signature.
// ---------------------------------------------------------------------------

async function waitForTaskStatus(
  opts: DriveOptions,
  taskId: string,
  acceptable: ReadonlySet<DrivenTaskStatus>,
  timings: DriveTimings,
  timeoutMs: number,
  deps: DriveDeps,
): Promise<DrivenTaskStatus> {
  let last: DrivenTaskStatus = 'pending'
  const outcome = await waitFor(
    async () => {
      const detail = await getTaskDetail(opts, taskId, deps)
      last = detail.task.status
      return acceptable.has(last)
    },
    {
      label: `task ${taskId} → ${[...acceptable].join('|')}`,
      timeoutMs,
      intervalMs: timings.pollIntervalMs,
    },
    deps,
  )
  if (outcome.status === 'timeout') {
    throw new Error(
      `timed out waiting for task ${taskId} to reach ${[...acceptable].join('|')} ` +
        `(last status: ${last}, ${outcome.elapsedMs}ms elapsed)`,
    )
  }
  return last
}

async function waitForPhaseStatus(
  opts: DriveOptions,
  phaseId: string,
  acceptable: ReadonlySet<DrivenPhaseStatus>,
  timings: DriveTimings,
  timeoutMs: number,
  deps: DriveDeps,
): Promise<DrivenPhaseStatus> {
  let last: DrivenPhaseStatus = 'pending'
  const outcome = await waitFor(
    async () => {
      const planRes = await getPlan(opts, deps)
      const phase = planRes.plan.phases.find((p) => p.id === phaseId)
      if (!phase) return false
      last = phase.status
      return acceptable.has(last)
    },
    {
      label: `phase ${phaseId} → ${[...acceptable].join('|')}`,
      timeoutMs,
      intervalMs: timings.pollIntervalMs,
    },
    deps,
  )
  if (outcome.status === 'timeout') {
    throw new Error(
      `timed out waiting for phase ${phaseId} to reach ${[...acceptable].join('|')} ` +
        `(last status: ${last}, ${outcome.elapsedMs}ms elapsed)`,
    )
  }
  return last
}

/**
 * v0.8.4.1 P1.1: integration-wait that ALSO polls approval rows.
 *
 * `PhaseIntegrationWorkflow` opens an approval_requests row BEFORE
 * flipping the phase to `integrating`. So if drive only polled the
 * phase status, an approval-gated phase would sit in `executing`
 * forever (until the workflow's own 24h timeout). This helper
 * checks both signals on every tick:
 *
 *   - if the phase has reached an `acceptable` terminal state → return it
 *   - else if any pending approval rows exist → call `resolveApprovals`
 *     - 'ok'    → keep polling (the workflow will progress past the gate)
 *     - 'paused' → return `{kind: 'paused'}` so the caller can bail
 *
 * Timeouts still throw — a hung workflow is a real failure even when
 * --approve all is in play.
 */
type PhaseWaitOutcome =
  | { kind: 'phase'; status: DrivenPhaseStatus }
  | { kind: 'paused' }

async function waitForPhaseStatusOrApprovals(
  opts: DriveOptions,
  phaseId: string,
  acceptable: ReadonlySet<DrivenPhaseStatus>,
  timings: DriveTimings,
  timeoutMs: number,
  deps: DriveDeps,
): Promise<PhaseWaitOutcome> {
  let lastStatus: DrivenPhaseStatus = 'pending'
  let paused = false
  const outcome = await waitFor(
    async () => {
      const planRes = await getPlan(opts, deps)
      const phase = planRes.plan.phases.find((p) => p.id === phaseId)
      if (phase) {
        lastStatus = phase.status
        if (acceptable.has(lastStatus)) return true
      }
      // Phase still in flight — see if the workflow is parked at an
      // approval gate. resolveApprovals is a no-op when nothing's
      // pending, so we can call it on every tick safely.
      const approvalOutcome = await resolveApprovals(opts, deps)
      if (approvalOutcome === 'paused') {
        paused = true
        return true // exit the wait loop
      }
      return false
    },
    {
      label: `phase ${phaseId} → ${[...acceptable].join('|')} (with approval poll)`,
      timeoutMs,
      intervalMs: timings.pollIntervalMs,
    },
    deps,
  )
  if (paused) return { kind: 'paused' }
  if (outcome.status === 'timeout') {
    throw new Error(
      `timed out waiting for phase ${phaseId} to reach ${[...acceptable].join('|')} ` +
        `(last status: ${lastStatus}, ${outcome.elapsedMs}ms elapsed)`,
    )
  }
  return { kind: 'phase', status: lastStatus }
}

// ---------------------------------------------------------------------------
// Per-task loop
// ---------------------------------------------------------------------------

const DRIVABLE_TASK_TERMINAL: ReadonlySet<DrivenTaskStatus> = new Set([
  'ready_to_merge',
  'merged',
])

/**
 * Drive a single task from its current state to `ready_to_merge`.
 * Returns:
 *   - 'ready_to_merge' on success
 *   - 'blocked' on a hard stop (caller should bail with exit code 1)
 *
 * The state machine:
 *   pending|ready  → POST /run, wait for in_review
 *   in_review      → POST /review
 *   fixing         → POST /fix, wait for in_review, then loop
 *   blocked|failed → return 'blocked'
 *   ready_to_merge|merged → return 'ready_to_merge'
 */
export async function driveTask(
  opts: DriveOptions,
  taskId: string,
  timings: DriveTimings,
  deps: DriveDeps,
): Promise<'ready_to_merge' | 'blocked'> {
  // Cap the number of state-machine iterations so a buggy server (or
  // hostile mock) can't put us in an infinite loop. Each cycle should
  // make forward progress; 12 is well above the contractual max review
  // cycles.
  const MAX_CYCLES = 12
  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    const detail = await getTaskDetail(opts, taskId, deps)
    const status = detail.task.status

    if (DRIVABLE_TASK_TERMINAL.has(status)) {
      deps.log(`[drive] task ${taskId} is ${status} — done`)
      return 'ready_to_merge'
    }

    if (status === 'blocked' || status === 'failed') {
      deps.errLog(
        `[drive] task ${taskId} is ${status} — investigate via \`pm-go doctor\` ` +
          `or POST /tasks/${taskId}/override-review`,
      )
      return 'blocked'
    }

    if (status === 'pending' || status === 'ready') {
      deps.log(`[drive] task ${taskId} is ${status} — POST /tasks/${taskId}/run`)
      await postEmpty(`${opts.apiUrl}/tasks/${taskId}/run`, deps)
      await waitForTaskStatus(
        opts,
        taskId,
        new Set(['in_review', 'ready_to_merge', 'merged', 'blocked', 'failed']),
        timings,
        timings.taskRunTimeoutMs,
        deps,
      )
      continue
    }

    if (status === 'running') {
      // Workflow already started — wait for it to land in in_review.
      deps.log(`[drive] task ${taskId} is running — waiting for in_review`)
      await waitForTaskStatus(
        opts,
        taskId,
        new Set(['in_review', 'ready_to_merge', 'merged', 'blocked', 'failed']),
        timings,
        timings.taskRunTimeoutMs,
        deps,
      )
      continue
    }

    if (status === 'in_review') {
      deps.log(
        `[drive] task ${taskId} is in_review — POST /tasks/${taskId}/review`,
      )
      await postEmpty(`${opts.apiUrl}/tasks/${taskId}/review`, deps)
      // Wait for review to land — task goes to ready_to_merge (pass),
      // fixing (changes_requested), or blocked.
      await waitForTaskStatus(
        opts,
        taskId,
        new Set(['ready_to_merge', 'merged', 'fixing', 'blocked', 'failed']),
        timings,
        timings.taskReviewTimeoutMs,
        deps,
      )
      continue
    }

    if (status === 'fixing') {
      deps.log(`[drive] task ${taskId} is fixing — POST /tasks/${taskId}/fix`)
      await postEmpty(`${opts.apiUrl}/tasks/${taskId}/fix`, deps)
      // After /fix the task re-enters the review loop — wait for
      // in_review (cycle continues) or terminal.
      await waitForTaskStatus(
        opts,
        taskId,
        new Set(['in_review', 'ready_to_merge', 'merged', 'blocked', 'failed']),
        timings,
        timings.taskFixTimeoutMs,
        deps,
      )
      continue
    }

    // Unknown status — defensive bail-out.
    deps.errLog(`[drive] task ${taskId} unexpected status='${status}' — stopping`)
    return 'blocked'
  }

  deps.errLog(
    `[drive] task ${taskId} did not reach ready_to_merge after ${MAX_CYCLES} cycles`,
  )
  return 'blocked'
}

// ---------------------------------------------------------------------------
// Approval loop
// ---------------------------------------------------------------------------

/**
 * Resolve every pending approval row for the plan according to the
 * --approve mode. Returns:
 *   - 'ok' when every pending row was approved (or there were none)
 *   - 'paused' when the policy declined to approve (`none` mode, or the
 *     interactive user said 'n') — caller should bail with exit code 1.
 */
export async function resolveApprovals(
  opts: DriveOptions,
  deps: DriveDeps,
): Promise<'ok' | 'paused'> {
  const approvals = await listApprovals(opts, deps)
  const pending = approvals.filter((a) => a.status === 'pending')
  if (pending.length === 0) {
    return 'ok'
  }

  deps.log(`[drive] ${pending.length} pending approval(s) for plan ${opts.planId}`)

  if (opts.approve === 'none') {
    deps.errLog(
      `[drive] --approve none: refusing to auto-approve. Resolve manually ` +
        `via POST /tasks/:id/approve or POST /plans/${opts.planId}/approve-all-pending.`,
    )
    return 'paused'
  }

  if (opts.approve === 'all') {
    deps.log(
      `[drive] --approve all: POST /plans/${opts.planId}/approve-all-pending`,
    )
    const body = (await postEmpty(
      `${opts.apiUrl}/plans/${opts.planId}/approve-all-pending`,
      deps,
      { reason: 'drive --approve all', approvedBy: 'pm-go-cli' },
    )) as {
      approvedCount?: number
      skippedCount?: number
      skipped?: { reason: string }[]
    }
    deps.log(
      `[drive] approve-all-pending: approved=${body.approvedCount ?? 0} ` +
        `skipped=${body.skippedCount ?? 0}`,
    )
    if ((body.skippedCount ?? 0) > 0) {
      deps.errLog(
        `[drive] some approvals were skipped (catastrophic risk band, or ` +
          `task not yet review-ready). They must be resolved by an operator.`,
      )
      return 'paused'
    }
    return 'ok'
  }

  // interactive
  for (const row of pending) {
    const subject =
      row.subject === 'task' && row.taskId
        ? `task ${row.taskId}`
        : `plan ${opts.planId}`
    const ok = await deps.prompt(
      `[drive] approve ${subject} (risk=${row.riskBand ?? 'unknown'})? [Y/n] `,
    )
    if (!ok) {
      deps.errLog(`[drive] interactive declined approval for ${subject}`)
      return 'paused'
    }
    if (row.subject === 'task' && row.taskId) {
      await postEmpty(`${opts.apiUrl}/tasks/${row.taskId}/approve`, deps, {
        approvedBy: 'pm-go-cli',
      })
    } else {
      await postEmpty(`${opts.apiUrl}/plans/${opts.planId}/approve`, deps, {
        approvedBy: 'pm-go-cli',
      })
    }
    deps.log(`[drive] approved ${subject}`)
  }
  return 'ok'
}

// ---------------------------------------------------------------------------
// Per-phase loop
// ---------------------------------------------------------------------------

/**
 * Drive a single phase from its current state to `completed`. Returns:
 *   - 'completed' on success
 *   - 'blocked' on a hard stop (caller should bail)
 *   - 'paused' when an approval was declined
 */
export async function drivePhase(
  opts: DriveOptions,
  phase: DrivenPhase,
  tasks: DrivenTask[],
  timings: DriveTimings,
  deps: DriveDeps,
): Promise<'completed' | 'blocked' | 'paused'> {
  deps.log(
    `[drive] phase ${phase.index} (${phase.title}) status=${phase.status}`,
  )
  if (phase.status === 'completed') return 'completed'
  if (phase.status === 'blocked' || phase.status === 'failed') {
    deps.errLog(
      `[drive] phase ${phase.id} is ${phase.status} — operator must use ` +
        `POST /phases/${phase.id}/override-audit if appropriate`,
    )
    return 'blocked'
  }

  // 1. Drive every task in mergeOrder to ready_to_merge.
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  // mergeOrder is the canonical sequence. When it's empty BUT the
  // phase has tasks, fall back to the task list order (planner shape
  // bug we don't want to swallow silently — log it loudly so the
  // operator can fix the plan, but still drive the tasks rather than
  // skipping straight to integration on an empty array).
  let order: readonly string[]
  if (phase.mergeOrder.length > 0) {
    order = phase.mergeOrder
  } else if (tasks.length > 0) {
    deps.errLog(
      `[drive] phase ${phase.id} has ${tasks.length} task(s) but empty ` +
        `mergeOrder — falling back to task-list order. The planner left ` +
        `this phase malformed; please file a bug.`,
    )
    order = tasks.map((t) => t.id)
  } else {
    order = []
  }
  for (const taskId of order) {
    const t = taskMap.get(taskId)
    if (!t) {
      deps.errLog(`[drive] phase ${phase.id} references unknown task ${taskId}`)
      return 'blocked'
    }
    if (DRIVABLE_TASK_TERMINAL.has(t.status)) continue
    const outcome = await driveTask(opts, taskId, timings, deps)
    if (outcome === 'blocked') return 'blocked'
  }

  // 2. POST /phases/:id/integrate — only required while phase is still
  //    `executing`. If the phase already advanced (idempotent re-drive
  //    after a crash), skip straight to the next gate.
  // Refresh phase status before deciding.
  const refreshed = (await getPlan(opts, deps)).plan.phases.find(
    (p) => p.id === phase.id,
  )
  let phaseStatus: DrivenPhaseStatus = refreshed?.status ?? phase.status

  if (phaseStatus === 'executing' || phaseStatus === 'integrating') {
    if (phaseStatus === 'executing') {
      deps.log(`[drive] phase ${phase.id}: POST /phases/${phase.id}/integrate`)
      await postEmpty(`${opts.apiUrl}/phases/${phase.id}/integrate`, deps)
    } else {
      deps.log(
        `[drive] phase ${phase.id}: already integrating — waiting for next gate`,
      )
    }
    // v0.8.4.1 P1.1: PhaseIntegrationWorkflow opens approval_requests
    // BEFORE flipping the phase to `integrating`. Use the combined
    // helper that polls phase status AND pending approvals on every
    // tick, so --approve all can unblock the gate promptly without
    // waiting for the integrate timeout.
    const integrateWait = await waitForPhaseStatusOrApprovals(
      opts,
      phase.id,
      new Set(['auditing', 'completed', 'blocked', 'failed']),
      timings,
      timings.phaseIntegrateTimeoutMs,
      deps,
    )
    if (integrateWait.kind === 'paused') return 'paused'
    phaseStatus = integrateWait.status
  }

  // 3. Final approval sweep — by now the workflow has crossed the
  //    integration gate, but a plan-scoped approval may still be
  //    pending. resolveApprovals is a no-op when nothing's pending.
  const approvalOutcome = await resolveApprovals(opts, deps)
  if (approvalOutcome === 'paused') return 'paused'

  // After approvals, the workflow may need a few more ticks to flip
  // phase.status. Re-poll.
  if (phaseStatus !== 'auditing' && phaseStatus !== 'completed') {
    phaseStatus = await waitForPhaseStatus(
      opts,
      phase.id,
      new Set(['auditing', 'completed', 'blocked', 'failed']),
      timings,
      timings.phaseIntegrateTimeoutMs,
      deps,
    )
  }

  if (phaseStatus === 'blocked' || phaseStatus === 'failed') {
    deps.errLog(
      `[drive] phase ${phase.id} ${phaseStatus} after integrate — ` +
        `inspect via GET /phases/${phase.id}; override-audit may apply`,
    )
    return 'blocked'
  }

  // 4. POST /phases/:id/audit (only when status='auditing'; if integrate
  //    already moved straight to 'completed' we skip).
  if (phaseStatus === 'auditing') {
    deps.log(`[drive] phase ${phase.id}: POST /phases/${phase.id}/audit`)
    await postEmpty(`${opts.apiUrl}/phases/${phase.id}/audit`, deps)
    phaseStatus = await waitForPhaseStatus(
      opts,
      phase.id,
      new Set(['completed', 'blocked', 'failed']),
      timings,
      timings.phaseAuditTimeoutMs,
      deps,
    )
  }

  if (phaseStatus === 'completed') {
    deps.log(`[drive] phase ${phase.id} completed`)
    return 'completed'
  }
  deps.errLog(
    `[drive] phase ${phase.id} ended in ${phaseStatus} — operator must ` +
      `inspect the latest phase audit and decide on override-audit`,
  )
  return 'blocked'
}

// ---------------------------------------------------------------------------
// Top-level driver
// ---------------------------------------------------------------------------

export const EXIT_OK = 0
export const EXIT_BLOCKED = 1
export const EXIT_ARGV = 2
export const EXIT_RELEASE_FAILED = 3
/**
 * v0.8.4.1: drive paused waiting for an operator to resolve approvals.
 * Distinct from EXIT_BLOCKED (which means a hard stop the operator
 * can't fix without `pm-go doctor` / override-review / re-driving).
 * `pm-go implement` uses this to keep the supervisor stack alive so
 * the operator can approve via the TUI/API and re-run drive.
 */
export const EXIT_PAUSED = 4

/**
 * Drive a plan from its current state to `released`. Returns the
 * intended process exit code.
 */
export async function runDrive(
  options: DriveOptions,
  deps: DriveDeps,
  timings: DriveTimings = DEFAULT_TIMINGS,
): Promise<number> {
  deps.log('')
  deps.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  deps.log('  pm-go drive')
  deps.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  deps.log(`  plan:    ${options.planId}`)
  deps.log(`  api:     ${options.apiUrl}`)
  deps.log(`  approve: ${options.approve}`)
  deps.log('')

  // Identity probe — refuse to drive against a port held by another
  // service. Without this, drive would issue /plans, /tasks/*/run, and
  // /approve-all-pending requests against whatever happened to be
  // listening on apiPort, surfacing confusing downstream errors
  // instead of the real diagnosis. probePmGoApi throws
  // PmGoIdentityMismatchError on any failure (network, non-2xx, or
  // identity mismatch); we surface the structured message and exit
  // EXIT_BLOCKED before the first plan request so /plans, /tasks/*/run
  // and /approve-all-pending never reach a foreign target.
  try {
    await probePmGoApi(deps.fetch, `${options.apiUrl}/health`)
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      deps.errLog(err.message)
      return EXIT_BLOCKED
    }
    throw err
  }

  let planRes: PlanResponse
  try {
    planRes = await getPlan(options, deps)
  } catch (err) {
    deps.errLog(`[drive] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT_BLOCKED
  }

  // Phases are returned in index order by the API. Drive each in turn.
  for (const phase of planRes.plan.phases) {
    // Refresh task list per phase so mid-loop state changes (e.g.
    // running tasks finishing) are seen. Wrap the per-phase fetch +
    // drive in try/catch so expected operator-action conditions
    // (409 from /integrate when phase is in a wrong state, wait
    // timeouts, malformed plans) become EXIT_BLOCKED with an
    // actionable log instead of escaping as top-level CLI failures.
    // (v0.8.4.1 P1.2: previously these threw past runDrive.)
    let outcome: 'completed' | 'blocked' | 'paused'
    try {
      const refreshed = await getPlan(options, deps)
      const refreshedPhase = refreshed.plan.phases.find(
        (p) => p.id === phase.id,
      )
      if (!refreshedPhase) {
        deps.errLog(`[drive] phase ${phase.id} disappeared mid-loop`)
        return EXIT_BLOCKED
      }
      const phaseTasks = refreshed.plan.tasks.filter(
        (t) => t.phaseId === phase.id,
      )
      outcome = await drivePhase(
        options,
        refreshedPhase,
        phaseTasks,
        timings,
        deps,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      deps.errLog(
        `[drive] phase ${phase.id} (${phase.title}) drive failed: ${msg}`,
      )
      deps.errLog(
        `[drive] inspect via GET ${options.apiUrl}/phases/${phase.id}; ` +
          `re-drive after the underlying issue is resolved`,
      )
      return EXIT_BLOCKED
    }
    if (outcome === 'blocked') return EXIT_BLOCKED
    if (outcome === 'paused') return EXIT_PAUSED
  }

  // All phases completed — kick off completion audit.
  deps.log(`[drive] all phases completed — POST /plans/${options.planId}/complete`)
  try {
    await postEmpty(`${options.apiUrl}/plans/${options.planId}/complete`, deps)
  } catch (err) {
    deps.errLog(`[drive] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT_RELEASE_FAILED
  }

  // Poll for latestCompletionAudit.outcome ∈ {pass, blocked, changes_requested}.
  let completionOutcome: CompletionAuditSummary['outcome'] | null = null
  const completion = await waitFor(
    async () => {
      const res = await getPlan(options, deps)
      const outcome = res.latestCompletionAudit?.outcome
      if (outcome === 'pass' || outcome === 'blocked' || outcome === 'changes_requested') {
        completionOutcome = outcome
        return true
      }
      return false
    },
    {
      label: `plan ${options.planId} completion audit`,
      timeoutMs: timings.planCompleteTimeoutMs,
      intervalMs: timings.pollIntervalMs,
    },
    deps,
  )
  if (completion.status === 'timeout') {
    deps.errLog(
      `[drive] timed out waiting for completion audit (${completion.elapsedMs}ms)`,
    )
    return EXIT_RELEASE_FAILED
  }
  if (completionOutcome !== 'pass') {
    deps.errLog(
      `[drive] completion audit outcome=${completionOutcome}; refusing to release. ` +
        `Inspect via GET /plans/${options.planId} and re-drive after the ` +
        `audit findings are addressed.`,
    )
    return EXIT_RELEASE_FAILED
  }
  deps.log(`[drive] completion audit pass`)

  // Release.
  deps.log(`[drive] POST /plans/${options.planId}/release`)
  try {
    await postEmpty(`${options.apiUrl}/plans/${options.planId}/release`, deps)
  } catch (err) {
    deps.errLog(`[drive] ${err instanceof Error ? err.message : String(err)}`)
    return EXIT_RELEASE_FAILED
  }

  deps.log('')
  deps.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  deps.log(`  plan ${options.planId} released`)
  deps.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  deps.log('')
  return EXIT_OK
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

export const DRIVE_USAGE = `Usage: pm-go drive --plan <uuid> [options]

Drives a submitted plan all the way to released by issuing the right
sequence of API calls (run/review/fix/integrate/audit/complete/release)
and pausing only when human approval is needed. Assumes the API is
already running (use \`pm-go run\` to start it).

Options:
  --plan <uuid>          Plan id to drive (required).
  --port, -p <n>         API port (default: 3001; ignored when --api-url given).
  --api-url <url>        API base URL (default: http://localhost:<port>).
  --approve <mode>       all | none | interactive (default: all).
                           all         — auto-approve every pending row
                           none        — pause on first pending approval
                           interactive — prompt Y/n for each
  --help, -h             Show this message.

Examples:
  pm-go drive --plan a1b2c3d4-...
  pm-go drive --plan a1b2c3d4-... --approve interactive
  pm-go drive --plan a1b2c3d4-... --port 4002 --approve none
`

export interface DriveCliDeps {
  argv: readonly string[]
  log: (line: string) => void
  errLog: (line: string) => void
  buildDriveDeps: () => DriveDeps
}

/**
 * CLI dispatcher for `pm-go drive`. Mirrors `runCli`. Returns the exit
 * code; the index.ts wrapper calls `process.exit`.
 */
export async function driveCli(cliDeps: DriveCliDeps): Promise<number> {
  const parsed = parseDriveArgv(cliDeps.argv)
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      cliDeps.log(DRIVE_USAGE)
      return EXIT_OK
    }
    cliDeps.errLog(`pm-go drive: ${parsed.error}`)
    cliDeps.errLog('')
    cliDeps.errLog(DRIVE_USAGE)
    return EXIT_ARGV
  }

  const deps = cliDeps.buildDriveDeps()
  return runDrive(parsed.options, deps)
}
