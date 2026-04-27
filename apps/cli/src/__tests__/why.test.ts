import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runWhy, WHY_USAGE, type WhyDeps } from '../why.js'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const PLAN_ID = '11111111-2222-4333-8444-555555555555'
const PHASE_1 = 'cccccccc-3333-4333-8333-333333333333'
const PHASE_2 = 'dddddddd-4444-4444-8444-444444444444'
const TASK_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const UNKNOWN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

interface RouteSpec {
  /** Status code to return. 404 means the route does not match. */
  status?: number
  /** JSON body — serialised verbatim. Ignored when status === 404. */
  body?: unknown
}

/**
 * Build a mock fetch that consults `routes` keyed by the URL path. Any
 * URL not in the map returns 404 — that's how the dispatcher knows to
 * try the next route. Tests only declare the routes they care about.
 */
function makeDeps(routes: Record<string, RouteSpec>): {
  deps: WhyDeps
  out: string[]
  errs: string[]
  calls: string[]
} {
  const out: string[] = []
  const errs: string[] = []
  const calls: string[] = []
  const fetchFn: typeof globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
  ) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    calls.push(url)
    // Strip the localhost prefix so the keys in `routes` can be path-only.
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const route = routes[path]
    if (!route || route.status === 404) {
      return new Response('not found', { status: 404 })
    }
    const status = route.status ?? 200
    const body =
      typeof route.body === 'string'
        ? route.body
        : JSON.stringify(route.body ?? {})
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return {
    deps: {
      fetch: fetchFn,
      env: {},
      write: (l) => out.push(l),
      errLog: (l) => errs.push(l),
    },
    out,
    errs,
    calls,
  }
}

// ---------------------------------------------------------------------------
// argv handling
// ---------------------------------------------------------------------------

describe('runWhy argv', () => {
  it('errors with usage when no <id> is provided', async () => {
    const { deps, errs } = makeDeps({})
    const code = await runWhy(deps, [])
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => /missing <id>/.test(l)))
    assert.ok(errs.some((l) => /Usage: pm-go why/.test(l)))
  })

  it('errors when too many arguments are passed', async () => {
    const { deps, errs } = makeDeps({})
    const code = await runWhy(deps, [PLAN_ID, 'extra'])
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => /unexpected argument/.test(l)))
  })

  it('rejects a non-UUID <id>', async () => {
    const { deps, errs } = makeDeps({})
    const code = await runWhy(deps, ['not-a-uuid'])
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => /must be a UUID/.test(l)))
  })

  it('exposes WHY_USAGE for index.ts to render --help', () => {
    assert.match(WHY_USAGE, /Usage: pm-go why/)
    assert.match(WHY_USAGE, /<id>/)
  })
})

// ---------------------------------------------------------------------------
// Plan blocked by completion audit
// ---------------------------------------------------------------------------

describe('runWhy plan', () => {
  it('explains a plan blocked by a phase audit and emits the override curl', async () => {
    const { deps, out, errs } = makeDeps({
      [`/plans/${PLAN_ID}`]: {
        status: 200,
        body: {
          plan: {
            id: PLAN_ID,
            status: 'blocked',
            phases: [
              {
                id: PHASE_1,
                index: 0,
                title: 'Foundation',
                status: 'completed',
              },
              {
                id: PHASE_2,
                index: 1,
                title: 'Implementation',
                status: 'blocked',
              },
            ],
          },
          latestCompletionAudit: null,
        },
      },
    })
    const code = await runWhy(deps, [PLAN_ID])
    assert.strictEqual(code, 0)
    assert.strictEqual(errs.length, 0)
    assert.strictEqual(out.length, 1)
    const line = out[0] as string
    assert.match(line, new RegExp(`plan ${PLAN_ID} is blocked`))
    assert.match(line, new RegExp(`phase ${PHASE_2}`))
    assert.match(line, /'Implementation'/)
    assert.match(
      line,
      new RegExp(`override-audit`),
    )
  })

  it('prefers the completion-audit override when the audit failed', async () => {
    const { deps, out } = makeDeps({
      [`/plans/${PLAN_ID}`]: {
        status: 200,
        body: {
          plan: {
            id: PLAN_ID,
            status: 'blocked',
            phases: [],
          },
          latestCompletionAudit: {
            id: 'aaaa1111-2222-4333-8444-555555555555',
            finalPhaseId: PHASE_1,
            outcome: 'changes_requested',
            createdAt: '2026-04-27T11:00:00.000Z',
          },
        },
      },
    })
    const code = await runWhy(deps, [PLAN_ID])
    assert.strictEqual(code, 0)
    const line = out[0] as string
    assert.match(line, /completion audit returned changes_requested/)
    assert.match(line, /override-completion-audit/)
  })

  it('renders an in-progress plan with phase counts', async () => {
    const { deps, out } = makeDeps({
      [`/plans/${PLAN_ID}`]: {
        status: 200,
        body: {
          plan: {
            id: PLAN_ID,
            status: 'executing',
            phases: [
              { id: PHASE_1, index: 0, title: 'A', status: 'completed' },
              { id: PHASE_2, index: 1, title: 'B', status: 'executing' },
            ],
          },
          latestCompletionAudit: null,
        },
      },
    })
    const code = await runWhy(deps, [PLAN_ID])
    assert.strictEqual(code, 0)
    const line = out[0] as string
    assert.match(line, /is executing/)
    assert.match(line, /2 phases, 1 completed, 1 executing/)
    assert.match(line, /pm-go drive --plan/)
  })
})

// ---------------------------------------------------------------------------
// Phase pending waiting for prior
// ---------------------------------------------------------------------------

describe('runWhy phase', () => {
  it('explains a pending phase waiting for a prior phase', async () => {
    const { deps, out, errs } = makeDeps({
      // /plans/<phaseId> 404s — that's how we fall through to /phases.
      [`/plans/${PHASE_2}`]: { status: 404 },
      [`/phases/${PHASE_2}`]: {
        status: 200,
        body: {
          phase: {
            id: PHASE_2,
            planId: PLAN_ID,
            index: 1,
            title: 'Implementation',
            status: 'pending',
          },
          latestMergeRun: null,
          latestPhaseAudit: null,
        },
      },
      // The renderer fetches plan siblings to name the prior blocker.
      [`/plans/${PLAN_ID}`]: {
        status: 200,
        body: {
          plan: {
            id: PLAN_ID,
            status: 'executing',
            phases: [
              {
                id: PHASE_1,
                index: 0,
                title: 'Foundation',
                status: 'executing',
              },
              {
                id: PHASE_2,
                index: 1,
                title: 'Implementation',
                status: 'pending',
              },
            ],
          },
          latestCompletionAudit: null,
        },
      },
    })
    const code = await runWhy(deps, [PHASE_2])
    assert.strictEqual(code, 0)
    assert.strictEqual(errs.length, 0)
    const line = out[0] as string
    assert.match(line, new RegExp(`phase ${PHASE_2} 'Implementation' is pending`))
    assert.match(line, new RegExp(`waiting for phase ${PHASE_1}`))
    assert.match(line, /'Foundation'/)
    assert.match(line, /currently executing/)
  })

  it('explains a blocked phase whose audit returned changes_requested', async () => {
    const { deps, out } = makeDeps({
      [`/plans/${PHASE_1}`]: { status: 404 },
      [`/phases/${PHASE_1}`]: {
        status: 200,
        body: {
          phase: {
            id: PHASE_1,
            planId: PLAN_ID,
            index: 0,
            title: 'Foundation',
            status: 'blocked',
          },
          latestMergeRun: null,
          latestPhaseAudit: {
            outcome: 'changes_requested',
            findings: [{ id: 'f1' }, { id: 'f2' }],
          },
        },
      },
    })
    const code = await runWhy(deps, [PHASE_1])
    assert.strictEqual(code, 0)
    const line = out[0] as string
    assert.match(line, /audit returned changes_requested/)
    assert.match(line, /override-audit/)
  })
})

// ---------------------------------------------------------------------------
// Task in_review with findings
// ---------------------------------------------------------------------------

describe('runWhy task', () => {
  it('explains an in_review task and surfaces the finding count', async () => {
    const { deps, out, errs } = makeDeps({
      [`/plans/${TASK_A}`]: { status: 404 },
      [`/phases/${TASK_A}`]: { status: 404 },
      [`/tasks/${TASK_A}`]: {
        status: 200,
        body: {
          task: {
            id: TASK_A,
            planId: PLAN_ID,
            title: 'Wire driver',
            status: 'in_review',
          },
          latestAgentRun: null,
          latestReviewReport: {
            outcome: 'changes_requested',
            findings: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }],
            cycleNumber: 2,
          },
        },
      },
    })
    const code = await runWhy(deps, [TASK_A])
    assert.strictEqual(code, 0)
    assert.strictEqual(errs.length, 0)
    const line = out[0] as string
    assert.match(line, new RegExp(`task ${TASK_A} 'Wire driver' is in_review`))
    assert.match(line, /3 findings/)
    assert.match(line, /cycle 2/)
    assert.match(line, new RegExp(`pm-go drive --plan ${PLAN_ID}`))
  })

  it('explains a running task with the started timestamp', async () => {
    const startedAt = '2026-04-27T11:30:00.000Z'
    const { deps, out } = makeDeps({
      [`/plans/${TASK_A}`]: { status: 404 },
      [`/phases/${TASK_A}`]: { status: 404 },
      [`/tasks/${TASK_A}`]: {
        status: 200,
        body: {
          task: {
            id: TASK_A,
            planId: PLAN_ID,
            title: 'Wire driver',
            status: 'running',
          },
          latestAgentRun: {
            role: 'implementer',
            status: 'running',
            startedAt,
          },
          latestReviewReport: null,
        },
      },
    })
    const code = await runWhy(deps, [TASK_A])
    assert.strictEqual(code, 0)
    const line = out[0] as string
    assert.match(line, /is running/)
    assert.match(line, new RegExp(startedAt))
  })
})

// ---------------------------------------------------------------------------
// Not-found fallback
// ---------------------------------------------------------------------------

describe('runWhy not-found', () => {
  it('errors with a hint when no route matches the id', async () => {
    // All three routes 404 — the dispatcher should fall through to the
    // "id not found" path and exit 1 with a doctor pointer.
    const { deps, out, errs } = makeDeps({
      [`/plans/${UNKNOWN_ID}`]: { status: 404 },
      [`/phases/${UNKNOWN_ID}`]: { status: 404 },
      [`/tasks/${UNKNOWN_ID}`]: { status: 404 },
    })
    const code = await runWhy(deps, [UNKNOWN_ID])
    assert.strictEqual(code, 1)
    assert.strictEqual(out.length, 0)
    assert.ok(errs.some((l) => /id .* not found/.test(l)))
    assert.ok(errs.some((l) => /pm-go doctor/.test(l)))
  })
})

// ---------------------------------------------------------------------------
// API_PORT env override
// ---------------------------------------------------------------------------

describe('runWhy API_PORT', () => {
  it('honors API_PORT when building the base URL', async () => {
    const { deps, calls, out } = makeDeps({})
    // Override the env via a fresh deps object — makeDeps() defaults to {}.
    const portDeps: WhyDeps = {
      ...deps,
      env: { API_PORT: '4002' },
    }
    const code = await runWhy(portDeps, [PLAN_ID])
    // Every URL the runner hit should have used port 4002.
    for (const url of calls) {
      assert.ok(
        url.startsWith('http://localhost:4002/'),
        `expected ${url} to use port 4002`,
      )
    }
    // Our routes map is empty so the fallback path runs — exit 1 + no output.
    assert.strictEqual(code, 1)
    assert.strictEqual(out.length, 0)
  })
})
