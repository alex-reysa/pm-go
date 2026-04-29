/**
 * `pm-go why <id>` — explain in one sentence why a plan / phase / task
 * is in its current state, and what the next action is.
 *
 * The command is a read-only diagnostic. It hits `GET /plans/<id>` first,
 * then `GET /phases/<id>`, then `GET /tasks/<id>`, picking the first one
 * that resolves with a recognised body shape and rendering one terse
 * human sentence keyed off the actual fields the API returned. If no
 * route matches the id, exit 1 with a hint to run `pm-go doctor`.
 *
 * All I/O is injected via WhyDeps so unit tests can substitute a fake
 * fetch per URL. Mirrors the dependency-injection pattern in
 * `status.ts` / `drive.ts`.
 *
 * Before any /plans, /phases, or /tasks request, runWhy gates on
 * `probePmGoApi` from `./lib/api-client.js`. A port held by a non-pm-go
 * service would otherwise parade past tryPlan/tryPhase/tryTask and
 * produce confusing 404s; the identity probe converts that into a
 * single structured error whose first line begins with
 * `[pm-go] port <port> is held by another service`, and the command
 * exits 1 without issuing any plan/phase/task lookup.
 */
import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from './lib/api-client.js'


export interface WhyDeps {
  /** Network fetch — the only I/O the command performs. */
  fetch: typeof globalThis.fetch
  /** Process env (defaults to process.env in production). */
  env: Record<string, string | undefined>
  /** Output sink for the success line — one call. */
  write: (line: string) => void
  /** Error sink for not-found / usage messages — one call. */
  errLog: (line: string) => void
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DEFAULT_API_PORT = 3001

/**
 * Run the why subcommand. Returns the process exit code so the dispatcher
 * in `index.ts` can `process.exit(code)` consistently with status / ps.
 *
 * The argv contract is exactly one positional UUID. `--help` / `-h` is
 * handled in `index.ts` before we get here so the deps object stays
 * minimal.
 */
export async function runWhy(
  deps: WhyDeps,
  argv: readonly string[],
): Promise<number> {
  if (argv.length === 0) {
    deps.errLog('pm-go why: missing <id>')
    deps.errLog('')
    deps.errLog(WHY_USAGE)
    return 2
  }
  if (argv.length > 1) {
    deps.errLog(`pm-go why: unexpected argument: ${argv[1]}`)
    deps.errLog('')
    deps.errLog(WHY_USAGE)
    return 2
  }
  const id = argv[0] as string
  if (!UUID_RE.test(id)) {
    deps.errLog(`pm-go why: <id> must be a UUID`)
    return 2
  }

  const apiPort = deps.env.API_PORT ?? String(DEFAULT_API_PORT)
  const baseUrl = `http://localhost:${apiPort}`

  // Identity gate — refuse to query /plans, /phases, or /tasks against
  // a port held by another service. probePmGoApi wraps every failure
  // (network, HTTP non-2xx, malformed JSON, identity mismatch) into a
  // single PmGoIdentityMismatchError whose first line begins with the
  // greppable `[pm-go] port <port> is held by another service` prefix.
  // We surface that message verbatim and return 1 before tryPlan /
  // tryPhase / tryTask issue their first GET — that way a foreign
  // service never produces the misleading "id ... not found" line.
  try {
    await probePmGoApi(deps.fetch, `${baseUrl}/health`)
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      deps.errLog(err.message)
      return 1
    }
    throw err
  }

  // Try /plans first, then /phases, then /tasks. Each helper returns:
  //   - 'rendered' if the body matched and a sentence was written
  //   - 'not-this-route' if 404 / 4xx / shape mismatch — try next route
  // Errors that aren't "not found" propagate (so a 500 from a sick API
  // surfaces instead of silently masquerading as "id not found").
  const planResult = await tryPlan(deps, baseUrl, id)
  if (planResult === 'rendered') return 0
  const phaseResult = await tryPhase(deps, baseUrl, id)
  if (phaseResult === 'rendered') return 0
  const taskResult = await tryTask(deps, baseUrl, id)
  if (taskResult === 'rendered') return 0

  deps.errLog(
    `id ${id} not found in /plans, /phases, or /tasks — check the UUID or stack health (pm-go doctor)`,
  )
  return 1
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * Narrow read model for `GET /plans/:id`. We only spell out the fields
 * the why-renderer needs — the API returns more (artifactIds, etc) and
 * we don't validate those.
 */
interface PlanResponseBody {
  plan?: {
    id: string
    status: string
    phases: PlanResponsePhase[]
  }
  latestCompletionAudit?: {
    id: string
    finalPhaseId: string
    outcome: string
    createdAt: string
  } | null
}

interface PlanResponsePhase {
  id: string
  index: number
  title: string
  status: string
}

async function tryPlan(
  deps: WhyDeps,
  baseUrl: string,
  id: string,
): Promise<'rendered' | 'not-this-route'> {
  const res = await deps.fetch(`${baseUrl}/plans/${id}`)
  if (res.status === 404) return 'not-this-route'
  if (!res.ok) return 'not-this-route'
  const body = (await res.json().catch(() => null)) as PlanResponseBody | null
  if (!body || typeof body !== 'object' || !body.plan) {
    return 'not-this-route'
  }
  deps.write(renderPlanSentence(body, baseUrl))
  return 'rendered'
}

function renderPlanSentence(body: PlanResponseBody, baseUrl: string): string {
  const plan = body.plan!
  const status = plan.status
  const phases = Array.isArray(plan.phases) ? plan.phases : []

  // Plan is blocked: most useful next-step is to identify the blocking
  // phase. If a completion-audit returned a non-pass outcome, name that
  // and the override curl. Otherwise, find a `blocked` phase and surface
  // its override path.
  if (status === 'blocked') {
    const audit = body.latestCompletionAudit
    if (audit && audit.outcome !== 'pass') {
      return (
        `plan ${plan.id} is blocked because completion audit returned ${audit.outcome}; ` +
        `override with: curl -X POST ${baseUrl}/plans/${plan.id}/override-completion-audit ` +
        `-d '{"reason":"...","overriddenBy":"..."}'`
      )
    }
    const blockedPhase = phases.find((p) => p.status === 'blocked')
    if (blockedPhase) {
      return (
        `plan ${plan.id} is blocked because phase ${blockedPhase.id} '${blockedPhase.title}' ` +
        `is blocked; override with: curl -X POST ${baseUrl}/phases/${blockedPhase.id}/override-audit ` +
        `-d '{"reason":"...","overriddenBy":"..."}'`
      )
    }
    return (
      `plan ${plan.id} is blocked but no blocked phase or failing completion audit was found; ` +
      `inspect with: curl ${baseUrl}/plans/${plan.id}`
    )
  }

  if (status === 'completed') {
    const audit = body.latestCompletionAudit
    if (audit && audit.outcome === 'pass') {
      return (
        `plan ${plan.id} is completed and the latest completion audit passed; ` +
        `release with: curl -X POST ${baseUrl}/plans/${plan.id}/release -d '{}'`
      )
    }
    return (
      `plan ${plan.id} is completed; run completion audit with: curl -X POST ` +
      `${baseUrl}/plans/${plan.id}/complete -d '{}'`
    )
  }

  // In-progress / draft / approved / executing / auditing — a counts
  // sentence is the most useful one-liner since the next action depends
  // on which phase is stuck. The drive loop is the canonical mover.
  const completedCount = phases.filter((p) => p.status === 'completed').length
  const executingCount = phases.filter((p) => p.status === 'executing').length
  return (
    `plan ${plan.id} is ${status}; ${phases.length} phase${
      phases.length === 1 ? '' : 's'
    }, ${completedCount} completed, ${executingCount} executing; ` +
    `drive with: pm-go drive --plan ${plan.id}`
  )
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/**
 * Narrow read model for `GET /phases/:id`. The API also returns
 * `latestMergeRun` and `latestPhaseAudit`; we only key off the audit
 * outcome and the phase row itself.
 */
interface PhaseResponseBody {
  phase?: {
    id: string
    planId: string
    index: number
    title: string
    status: string
  }
  latestMergeRun?: {
    failedTaskId: string | null
  } | null
  latestPhaseAudit?: {
    outcome: string
    findings?: unknown[]
  } | null
}

async function tryPhase(
  deps: WhyDeps,
  baseUrl: string,
  id: string,
): Promise<'rendered' | 'not-this-route'> {
  const res = await deps.fetch(`${baseUrl}/phases/${id}`)
  if (res.status === 404) return 'not-this-route'
  if (!res.ok) return 'not-this-route'
  const body = (await res.json().catch(() => null)) as PhaseResponseBody | null
  if (!body || typeof body !== 'object' || !body.phase) {
    return 'not-this-route'
  }
  // To explain a `pending` phase ("waiting for prior") we need the
  // sibling phase rows. Re-use GET /plans/:planId rather than
  // GET /phases?planId= so we get them in index order with statuses.
  let siblings: PlanResponsePhase[] = []
  if (body.phase.status === 'pending') {
    siblings = await loadSiblingPhases(deps, baseUrl, body.phase.planId)
  }
  deps.write(renderPhaseSentence(body, baseUrl, siblings))
  return 'rendered'
}

async function loadSiblingPhases(
  deps: WhyDeps,
  baseUrl: string,
  planId: string,
): Promise<PlanResponsePhase[]> {
  try {
    const res = await deps.fetch(`${baseUrl}/plans/${planId}`)
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as PlanResponseBody | null
    if (!body || !body.plan) return []
    return Array.isArray(body.plan.phases) ? body.plan.phases : []
  } catch {
    return []
  }
}

function renderPhaseSentence(
  body: PhaseResponseBody,
  baseUrl: string,
  siblings: PlanResponsePhase[],
): string {
  const phase = body.phase!
  const id = phase.id
  const title = phase.title

  if (phase.status === 'pending') {
    // Find the most recent prior phase that isn't completed.
    const sorted = [...siblings].sort((a, b) => a.index - b.index)
    const blockingPrior = sorted
      .filter((p) => p.index < phase.index)
      .find((p) => p.status !== 'completed')
    if (blockingPrior) {
      return (
        `phase ${id} '${title}' is pending; waiting for phase ${blockingPrior.id} ` +
        `'${blockingPrior.title}' to reach completed (currently ${blockingPrior.status})`
      )
    }
    return (
      `phase ${id} '${title}' is pending and ready to advance; promote with: ` +
      `curl -X POST ${baseUrl}/phases/${id}/advance -d '{}'`
    )
  }

  if (phase.status === 'blocked') {
    const audit = body.latestPhaseAudit
    if (audit && audit.outcome !== 'pass') {
      return (
        `phase ${id} '${title}' is blocked because audit returned ${audit.outcome}; ` +
        `override with: curl -X POST ${baseUrl}/phases/${id}/override-audit ` +
        `-d '{"reason":"...","overriddenBy":"..."}'`
      )
    }
    const failed = body.latestMergeRun?.failedTaskId
    if (failed) {
      return (
        `phase ${id} '${title}' is blocked because task ${failed} failed during integration; ` +
        `inspect with: curl ${baseUrl}/tasks/${failed}`
      )
    }
    return (
      `phase ${id} '${title}' is blocked; inspect with: curl ${baseUrl}/phases/${id}`
    )
  }

  if (phase.status === 'auditing') {
    return (
      `phase ${id} '${title}' is auditing; run audit with: curl -X POST ${baseUrl}/phases/${id}/audit -d '{}'`
    )
  }

  if (phase.status === 'integrating') {
    return (
      `phase ${id} '${title}' is integrating; PhaseIntegrationWorkflow in progress`
    )
  }

  if (phase.status === 'executing') {
    return (
      `phase ${id} '${title}' is executing; tasks running — drive with: pm-go drive --plan ${phase.planId}`
    )
  }

  if (phase.status === 'completed') {
    return `phase ${id} '${title}' is completed; nothing to do`
  }

  return `phase ${id} '${title}' is ${phase.status}; inspect with: curl ${baseUrl}/phases/${id}`
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

interface TaskResponseBody {
  task?: {
    id: string
    planId: string
    title: string
    status: string
  }
  latestAgentRun?: {
    role: string
    status: string
    startedAt?: string | null
    completedAt?: string | null
    stopReason?: string | null
  } | null
  latestReviewReport?: {
    outcome: string
    findings?: unknown[]
    cycleNumber?: number
  } | null
}

async function tryTask(
  deps: WhyDeps,
  baseUrl: string,
  id: string,
): Promise<'rendered' | 'not-this-route'> {
  const res = await deps.fetch(`${baseUrl}/tasks/${id}`)
  if (res.status === 404) return 'not-this-route'
  if (!res.ok) return 'not-this-route'
  const body = (await res.json().catch(() => null)) as TaskResponseBody | null
  if (!body || typeof body !== 'object' || !body.task) {
    return 'not-this-route'
  }
  deps.write(renderTaskSentence(body, baseUrl))
  return 'rendered'
}

function renderTaskSentence(body: TaskResponseBody, baseUrl: string): string {
  const task = body.task!
  const id = task.id
  const title = task.title
  const planId = task.planId

  if (task.status === 'running') {
    const startedAt = body.latestAgentRun?.startedAt ?? null
    const startedHint = startedAt ? `, started ${startedAt}` : ''
    return `task ${id} '${title}' is running; TaskExecutionWorkflow in progress${startedHint}`
  }

  if (task.status === 'in_review') {
    const review = body.latestReviewReport
    if (review) {
      const findingsCount = Array.isArray(review.findings)
        ? review.findings.length
        : 0
      const cycle = review.cycleNumber ?? '?'
      return (
        `task ${id} '${title}' is in_review; latest review report has ${findingsCount} ` +
        `finding${findingsCount === 1 ? '' : 's'} (cycle ${cycle}); fix with: pm-go drive --plan ${planId}`
      )
    }
    return (
      `task ${id} '${title}' is in_review; review pending — drive with: pm-go drive --plan ${planId}`
    )
  }

  if (task.status === 'fixing') {
    return (
      `task ${id} '${title}' is fixing; TaskFixWorkflow in progress — drive with: pm-go drive --plan ${planId}`
    )
  }

  if (task.status === 'blocked') {
    const review = body.latestReviewReport
    if (review && review.outcome !== 'pass') {
      const findingsCount = Array.isArray(review.findings)
        ? review.findings.length
        : 0
      return (
        `task ${id} '${title}' is blocked because review returned ${review.outcome} ` +
        `with ${findingsCount} finding${findingsCount === 1 ? '' : 's'}; ` +
        `override with: curl -X POST ${baseUrl}/tasks/${id}/override-review ` +
        `-d '{"reason":"...","overriddenBy":"..."}'`
      )
    }
    return (
      `task ${id} '${title}' is blocked; inspect with: curl ${baseUrl}/tasks/${id}`
    )
  }

  if (task.status === 'ready_to_merge') {
    return (
      `task ${id} '${title}' is ready_to_merge; integrate phase with: curl -X POST ${baseUrl}/phases/<phase-id>/integrate -d '{}'`
    )
  }

  if (task.status === 'merged') {
    return `task ${id} '${title}' is merged; nothing to do`
  }

  if (task.status === 'pending' || task.status === 'ready') {
    return (
      `task ${id} '${title}' is ${task.status}; start with: curl -X POST ${baseUrl}/tasks/${id}/run -d '{}'`
    )
  }

  if (task.status === 'failed') {
    const stopReason = body.latestAgentRun?.stopReason ?? null
    const stopHint = stopReason ? ` (stopReason=${stopReason})` : ''
    return `task ${id} '${title}' is failed${stopHint}; inspect with: curl ${baseUrl}/tasks/${id}`
  }

  return `task ${id} '${title}' is ${task.status}; inspect with: curl ${baseUrl}/tasks/${id}`
}

export const WHY_USAGE = `Usage: pm-go why <id>

Explain in one human sentence why a plan / phase / task is in its
current state and what the next action is. Tries GET /plans/<id> first,
then GET /phases/<id>, then GET /tasks/<id>; the first one that matches
gets rendered. Read-only — no state is modified.

Arguments:
  <id>        UUID of a plan, phase, or task.

Options:
  -h, --help  Show this message.`
