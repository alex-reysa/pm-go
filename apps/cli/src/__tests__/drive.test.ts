import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  driveCli,
  DEFAULT_TIMINGS,
  driveTask,
  drivePhase,
  parseDriveArgv,
  resolveApprovals,
  runDrive,
  type ApprovalRow,
  type DriveDeps,
  type DrivenPhase,
  type DrivenPhaseStatus,
  type DrivenPlan,
  type DrivenTask,
  type DrivenTaskStatus,
  type PlanResponse,
} from '../drive.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PLAN_ID = '11111111-2222-4333-8444-555555555555'
const TASK_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const TASK_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const PHASE_1 = 'cccccccc-3333-4333-8333-333333333333'
const PHASE_2 = 'dddddddd-4444-4444-8444-444444444444'
const API_URL = 'http://localhost:3001'

const FAST_TIMINGS = {
  pollIntervalMs: 1,
  taskRunTimeoutMs: 100,
  taskReviewTimeoutMs: 100,
  taskFixTimeoutMs: 100,
  phaseIntegrateTimeoutMs: 100,
  phaseAuditTimeoutMs: 100,
  planCompleteTimeoutMs: 100,
}

interface MockServerState {
  /** Tasks keyed by id; status is mutated by the test or the auto-advance helper. */
  tasks: Map<string, DrivenTaskStatus>
  /** Phases keyed by id. */
  phases: Map<string, DrivenPhaseStatus>
  /** Latest review outcome per task — drives /review's state transition. */
  reviewOutcomes: Map<string, 'pass' | 'changes_requested' | 'blocked'>
  /** latestCompletionAudit.outcome to surface from GET /plans/:id. */
  completionAudit: 'pass' | 'changes_requested' | 'blocked' | null
  /** Pending approval rows — reset by /approve-all-pending. */
  approvals: ApprovalRow[]
  /** Each fetch invocation is appended here for assertions. */
  calls: { method: string; url: string; body?: unknown }[]
  /** Hooks fired after each POST so tests can mutate the state machine. */
  onPost: Map<string, (state: MockServerState) => void>
  /** Phase definitions used to build GET /plans/:id responses. */
  phaseDefs: DrivenPhase[]
  /** Task definitions used to build GET /plans/:id responses. */
  taskDefs: DrivenTask[]
  /**
   * What the mock /health returns. `pm-go` (default) returns the
   * identity envelope so probePmGoApi succeeds; `foreign` returns a
   * 2xx body without the `service` field so probePmGoApi throws a
   * PmGoIdentityMismatchError (the ac-health-identity-3 path).
   */
  healthIdentity: 'pm-go' | 'foreign'
}

function makeState(overrides: Partial<MockServerState> = {}): MockServerState {
  const taskDefs: DrivenTask[] = overrides.taskDefs ?? [
    { id: TASK_A, phaseId: PHASE_1, status: 'pending', title: 'Task A' },
  ]
  const phaseDefs: DrivenPhase[] = overrides.phaseDefs ?? [
    {
      id: PHASE_1,
      index: 0,
      title: 'Phase 1',
      status: 'executing',
      mergeOrder: taskDefs.filter((t) => t.phaseId === PHASE_1).map((t) => t.id),
    },
  ]
  const tasks =
    overrides.tasks ??
    new Map<string, DrivenTaskStatus>(taskDefs.map((t) => [t.id, t.status]))
  const phases =
    overrides.phases ??
    new Map<string, DrivenPhaseStatus>(phaseDefs.map((p) => [p.id, p.status]))
  return {
    tasks,
    phases,
    reviewOutcomes: overrides.reviewOutcomes ?? new Map(),
    completionAudit: overrides.completionAudit ?? null,
    approvals: overrides.approvals ?? [],
    calls: [],
    onPost: overrides.onPost ?? new Map(),
    phaseDefs,
    taskDefs,
    healthIdentity: overrides.healthIdentity ?? 'pm-go',
  }
}

function makeDeps(state: MockServerState): DriveDeps & { logs: string[]; errs: string[] } {
  const logs: string[] = []
  const errs: string[] = []
  let nowMs = 0
  const fetchFn: typeof globalThis.fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    state.calls.push({ method, url, body })
    return handle(state, method, url, body)
  }) as typeof globalThis.fetch
  return {
    logs,
    errs,
    fetch: fetchFn,
    now: () => {
      nowMs += 1
      return nowMs
    },
    sleep: async () => {
      // Bump clock so waitFor's elapsed math advances.
      nowMs += 2
    },
    log: (l) => logs.push(l),
    errLog: (l) => errs.push(l),
    prompt: async () => true,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Mock router. Replicates only the subset of API behavior the driver
 * touches; every transition the driver needs is observable in `state`.
 */
function handle(
  state: MockServerState,
  method: string,
  url: string,
  body: unknown,
): Response {
  // GET /health — identity probe gate. Default returns the pm-go
  // envelope so probePmGoApi (called at the top of runDrive) succeeds;
  // tests that want to exercise a foreign service set
  // `healthIdentity: 'foreign'` and we return a 2xx body that lacks
  // the required `service` field.
  if (url.endsWith('/health') && method === 'GET') {
    if (state.healthIdentity === 'foreign') {
      return jsonResponse({ status: 'ok' })
    }
    return jsonResponse({
      service: 'pm-go-api',
      version: '0.8.6',
      instance: 'default',
      port: 3001,
    })
  }
  // GET /plans/:id
  let m = url.match(/\/plans\/([^/?]+)$/)
  if (m && method === 'GET') {
    const planRes = buildPlanResponse(state, m[1] as string)
    return jsonResponse(planRes)
  }
  // GET /tasks/:id
  m = url.match(/\/tasks\/([^/?]+)$/)
  if (m && method === 'GET') {
    const taskId = m[1] as string
    const status = state.tasks.get(taskId) ?? 'pending'
    const reviewOutcome = state.reviewOutcomes.get(taskId)
    return jsonResponse({
      task: { id: taskId, status },
      latestReviewReport: reviewOutcome ? { outcome: reviewOutcome } : null,
    })
  }
  // GET /approvals?planId=...
  if (url.includes('/approvals?planId=') && method === 'GET') {
    return jsonResponse({ approvals: state.approvals })
  }
  // POST /tasks/:id/run
  m = url.match(/\/tasks\/([^/]+)\/run$/)
  if (m && method === 'POST') {
    runHook(state, `POST /tasks/${m[1]}/run`)
    return jsonResponse({ taskId: m[1], workflowRunId: 'wf-run-1' }, 202)
  }
  // POST /tasks/:id/review
  m = url.match(/\/tasks\/([^/]+)\/review$/)
  if (m && method === 'POST') {
    runHook(state, `POST /tasks/${m[1]}/review`)
    return jsonResponse({ taskId: m[1], workflowRunId: 'wf-rev-1' }, 202)
  }
  // POST /tasks/:id/fix
  m = url.match(/\/tasks\/([^/]+)\/fix$/)
  if (m && method === 'POST') {
    runHook(state, `POST /tasks/${m[1]}/fix`)
    return jsonResponse({ taskId: m[1], workflowRunId: 'wf-fix-1' }, 202)
  }
  // POST /tasks/:id/approve
  m = url.match(/\/tasks\/([^/]+)\/approve$/)
  if (m && method === 'POST') {
    const tid = m[1]
    state.approvals = state.approvals.map((a) =>
      a.taskId === tid && a.status === 'pending' ? { ...a, status: 'approved' as const } : a,
    )
    return jsonResponse({ taskId: tid })
  }
  // POST /phases/:id/integrate
  m = url.match(/\/phases\/([^/]+)\/integrate$/)
  if (m && method === 'POST') {
    runHook(state, `POST /phases/${m[1]}/integrate`)
    return jsonResponse({ phaseId: m[1] }, 202)
  }
  // POST /phases/:id/audit
  m = url.match(/\/phases\/([^/]+)\/audit$/)
  if (m && method === 'POST') {
    runHook(state, `POST /phases/${m[1]}/audit`)
    return jsonResponse({ phaseId: m[1] }, 202)
  }
  // POST /plans/:id/approve-all-pending
  m = url.match(/\/plans\/([^/]+)\/approve-all-pending$/)
  if (m && method === 'POST') {
    const eligible = state.approvals.filter((a) => a.status === 'pending' && a.riskBand !== 'catastrophic')
    const skipped = state.approvals.filter((a) => a.status === 'pending' && a.riskBand === 'catastrophic')
    state.approvals = state.approvals.map((a) =>
      eligible.includes(a) ? { ...a, status: 'approved' as const } : a,
    )
    runHook(state, `POST /plans/${m[1]}/approve-all-pending`)
    return jsonResponse({
      planId: m[1],
      approvedCount: eligible.length,
      approvedIds: eligible.map((a) => a.id),
      skippedCount: skipped.length,
      skipped: skipped.map((a) => ({ id: a.id, taskId: a.taskId, reason: 'riskBand=catastrophic' })),
    })
  }
  // POST /plans/:id/approve
  m = url.match(/\/plans\/([^/]+)\/approve$/)
  if (m && method === 'POST') {
    state.approvals = state.approvals.map((a) =>
      a.subject === 'plan' && a.status === 'pending' ? { ...a, status: 'approved' as const } : a,
    )
    return jsonResponse({ planId: m[1] })
  }
  // POST /plans/:id/complete
  m = url.match(/\/plans\/([^/]+)\/complete$/)
  if (m && method === 'POST') {
    runHook(state, `POST /plans/${m[1]}/complete`)
    return jsonResponse({ planId: m[1] }, 202)
  }
  // POST /plans/:id/release
  m = url.match(/\/plans\/([^/]+)\/release$/)
  if (m && method === 'POST') {
    runHook(state, `POST /plans/${m[1]}/release`)
    return jsonResponse({ planId: m[1] }, 202)
  }
  return new Response(`mock router: no match for ${method} ${url}`, { status: 404 })
  // body unused but referenced for future extensions
  void body
}

function runHook(state: MockServerState, key: string) {
  const hook = state.onPost.get(key)
  if (hook) hook(state)
}

function buildPlanResponse(state: MockServerState, planId: string): PlanResponse {
  const phases: DrivenPhase[] = state.phaseDefs.map((p) => ({
    ...p,
    status: state.phases.get(p.id) ?? p.status,
  }))
  const tasks: DrivenTask[] = state.taskDefs.map((t) => ({
    ...t,
    status: state.tasks.get(t.id) ?? t.status,
  }))
  const plan: DrivenPlan = {
    id: planId,
    status: 'executing',
    phases,
    tasks,
  }
  return {
    plan,
    latestCompletionAudit:
      state.completionAudit !== null
        ? { outcome: state.completionAudit }
        : null,
  }
}

const baseOpts = {
  planId: PLAN_ID,
  apiUrl: API_URL,
  approve: 'all' as const,
}

// ---------------------------------------------------------------------------
// parseDriveArgv
// ---------------------------------------------------------------------------

describe('parseDriveArgv', () => {
  it('requires --plan', () => {
    const r = parseDriveArgv([])
    assert.ok(!r.ok)
    assert.match(r.error, /--plan/)
  })

  it('rejects non-UUID --plan', () => {
    const r = parseDriveArgv(['--plan', 'not-a-uuid'])
    assert.ok(!r.ok)
    assert.match(r.error, /must be a UUID/)
  })

  it('parses --plan + defaults', () => {
    const r = parseDriveArgv(['--plan', PLAN_ID])
    assert.ok(r.ok)
    assert.strictEqual(r.options.planId, PLAN_ID)
    assert.strictEqual(r.options.apiUrl, 'http://localhost:3001')
    assert.strictEqual(r.options.approve, 'all')
  })

  it('honours --port', () => {
    const r = parseDriveArgv(['--plan', PLAN_ID, '--port', '4002'])
    assert.ok(r.ok)
    assert.strictEqual(r.options.apiUrl, 'http://localhost:4002')
  })

  it('--api-url overrides --port', () => {
    const r = parseDriveArgv([
      '--plan',
      PLAN_ID,
      '--port',
      '4002',
      '--api-url',
      'https://api.example.com/',
    ])
    assert.ok(r.ok)
    // Trailing slash stripped.
    assert.strictEqual(r.options.apiUrl, 'https://api.example.com')
  })

  it('rejects --approve <bogus>', () => {
    const r = parseDriveArgv(['--plan', PLAN_ID, '--approve', 'maybe'])
    assert.ok(!r.ok)
    assert.match(r.error, /one of/)
  })

  it('accepts every approve mode', () => {
    for (const mode of ['all', 'none', 'interactive']) {
      const r = parseDriveArgv(['--plan', PLAN_ID, '--approve', mode])
      assert.ok(r.ok, `approve=${mode} should parse`)
      assert.strictEqual(r.options.approve, mode)
    }
  })

  it('returns help signal on --help', () => {
    const r = parseDriveArgv(['--help'])
    assert.ok(!r.ok)
    assert.strictEqual(r.error, 'help')
  })

  it('rejects unknown flags', () => {
    const r = parseDriveArgv(['--plan', PLAN_ID, '--bogus'])
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })

  it('rejects --port outside 1..65535', () => {
    const r = parseDriveArgv(['--plan', PLAN_ID, '--port', '0'])
    assert.ok(!r.ok)
    assert.match(r.error, /1\.\.65535/)
  })
})

// ---------------------------------------------------------------------------
// driveTask
// ---------------------------------------------------------------------------

describe('driveTask', () => {
  it('runs a pending task and waits for in_review, then reviews to ready_to_merge', async () => {
    const state = makeState({
      tasks: new Map([[TASK_A, 'pending']]),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map([
        // /run pushes the task into in_review
        [
          `POST /tasks/${TASK_A}/run`,
          (s) => s.tasks.set(TASK_A, 'in_review'),
        ],
        // /review pushes it to ready_to_merge
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => {
            s.tasks.set(TASK_A, 'ready_to_merge')
            s.reviewOutcomes.set(TASK_A, 'pass')
          },
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await driveTask(baseOpts, TASK_A, FAST_TIMINGS, deps)
    assert.strictEqual(outcome, 'ready_to_merge')
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.ok(posts.some((u) => u.endsWith(`/tasks/${TASK_A}/run`)))
    assert.ok(posts.some((u) => u.endsWith(`/tasks/${TASK_A}/review`)))
  })

  it('handles changes_requested -> fix -> re-review -> pass', async () => {
    const state = makeState({
      tasks: new Map([[TASK_A, 'pending']]),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [`POST /tasks/${TASK_A}/run`, (s) => s.tasks.set(TASK_A, 'in_review')],
        // First review -> changes_requested -> fixing.
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => {
            const prior = s.reviewOutcomes.get(TASK_A)
            if (prior === undefined) {
              s.tasks.set(TASK_A, 'fixing')
              s.reviewOutcomes.set(TASK_A, 'changes_requested')
            } else {
              // Second review -> pass.
              s.tasks.set(TASK_A, 'ready_to_merge')
              s.reviewOutcomes.set(TASK_A, 'pass')
            }
          },
        ],
        // /fix returns task to in_review for the next review pass.
        [`POST /tasks/${TASK_A}/fix`, (s) => s.tasks.set(TASK_A, 'in_review')],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await driveTask(baseOpts, TASK_A, FAST_TIMINGS, deps)
    assert.strictEqual(outcome, 'ready_to_merge')
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.strictEqual(posts.filter((u) => u.endsWith('/review')).length, 2)
    assert.strictEqual(posts.filter((u) => u.endsWith('/fix')).length, 1)
  })

  it('returns blocked when task is already blocked', async () => {
    const state = makeState({
      tasks: new Map([[TASK_A, 'blocked']]),
    })
    const deps = makeDeps(state)
    const outcome = await driveTask(baseOpts, TASK_A, FAST_TIMINGS, deps)
    assert.strictEqual(outcome, 'blocked')
    assert.ok(deps.errs.some((l) => l.includes('blocked')))
    // No POST happened — the driver did not attempt to run/review/fix.
    assert.strictEqual(state.calls.filter((c) => c.method === 'POST').length, 0)
  })

  it('returns blocked when task transitions to blocked mid-loop', async () => {
    const state = makeState({
      tasks: new Map([[TASK_A, 'pending']]),
      onPost: new Map([
        [`POST /tasks/${TASK_A}/run`, (s) => s.tasks.set(TASK_A, 'in_review')],
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => s.tasks.set(TASK_A, 'blocked'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await driveTask(baseOpts, TASK_A, FAST_TIMINGS, deps)
    assert.strictEqual(outcome, 'blocked')
  })

  it('skips /run when task is already ready_to_merge', async () => {
    const state = makeState({
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
    })
    const deps = makeDeps(state)
    const outcome = await driveTask(baseOpts, TASK_A, FAST_TIMINGS, deps)
    assert.strictEqual(outcome, 'ready_to_merge')
    assert.strictEqual(state.calls.filter((c) => c.method === 'POST').length, 0)
  })
})

// ---------------------------------------------------------------------------
// resolveApprovals
// ---------------------------------------------------------------------------

describe('resolveApprovals', () => {
  it('returns ok when there are no pending approvals', async () => {
    const state = makeState()
    const deps = makeDeps(state)
    const outcome = await resolveApprovals(baseOpts, deps)
    assert.strictEqual(outcome, 'ok')
  })

  it('approve=all calls /approve-all-pending and reports counts', async () => {
    const state = makeState({
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'medium' },
        { id: 'a2', subject: 'plan', status: 'pending', taskId: null, riskBand: 'low' },
      ],
    })
    const deps = makeDeps(state)
    const outcome = await resolveApprovals(baseOpts, deps)
    assert.strictEqual(outcome, 'ok')
    const posted = state.calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/approve-all-pending'),
    )
    assert.strictEqual(posted.length, 1)
    // The body must carry a non-empty `reason` per the API contract.
    assert.ok(
      posted[0]?.body && (posted[0].body as { reason?: string }).reason !== undefined,
    )
  })

  it('approve=all returns paused when some rows are skipped (catastrophic)', async () => {
    const state = makeState({
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'catastrophic' },
      ],
    })
    const deps = makeDeps(state)
    const outcome = await resolveApprovals(baseOpts, deps)
    assert.strictEqual(outcome, 'paused')
    assert.ok(deps.errs.some((l) => l.includes('skipped')))
  })

  it('approve=none pauses on the first pending approval', async () => {
    const state = makeState({
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'medium' },
      ],
    })
    const deps = makeDeps(state)
    const opts = { ...baseOpts, approve: 'none' as const }
    const outcome = await resolveApprovals(opts, deps)
    assert.strictEqual(outcome, 'paused')
    assert.ok(deps.errs.some((l) => l.includes('--approve none')))
    // No POST issued.
    assert.strictEqual(state.calls.filter((c) => c.method === 'POST').length, 0)
  })

  it('approve=interactive prompts and approves on Y', async () => {
    const state = makeState({
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'medium' },
        { id: 'a2', subject: 'plan', status: 'pending', taskId: null, riskBand: 'low' },
      ],
    })
    const deps = makeDeps(state)
    const opts = { ...baseOpts, approve: 'interactive' as const }
    const outcome = await resolveApprovals(opts, deps)
    assert.strictEqual(outcome, 'ok')
    const posted = state.calls
      .filter((c) => c.method === 'POST')
      .map((c) => c.url)
    // One per-task and one plan-scoped approval.
    assert.ok(posted.some((u) => u.endsWith(`/tasks/${TASK_A}/approve`)))
    assert.ok(posted.some((u) => u.endsWith(`/plans/${PLAN_ID}/approve`)))
  })

  it('approve=interactive pauses when the user declines (n)', async () => {
    const state = makeState({
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'medium' },
      ],
    })
    const deps = makeDeps(state)
    deps.prompt = async () => false
    const opts = { ...baseOpts, approve: 'interactive' as const }
    const outcome = await resolveApprovals(opts, deps)
    assert.strictEqual(outcome, 'paused')
    assert.strictEqual(state.calls.filter((c) => c.method === 'POST').length, 0)
  })
})

// ---------------------------------------------------------------------------
// drivePhase
// ---------------------------------------------------------------------------

describe('drivePhase', () => {
  it('happy path: runs every task, integrates, audits, completes', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'pending', title: 'A' },
      { id: TASK_B, phaseId: PHASE_1, status: 'pending', title: 'B' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A, TASK_B],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([
        [TASK_A, 'pending'],
        [TASK_B, 'pending'],
      ]),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [`POST /tasks/${TASK_A}/run`, (s) => s.tasks.set(TASK_A, 'in_review')],
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => s.tasks.set(TASK_A, 'ready_to_merge'),
        ],
        [`POST /tasks/${TASK_B}/run`, (s) => s.tasks.set(TASK_B, 'in_review')],
        [
          `POST /tasks/${TASK_B}/review`,
          (s) => s.tasks.set(TASK_B, 'ready_to_merge'),
        ],
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_1}/audit`,
          (s) => s.phases.set(PHASE_1, 'completed'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOpts,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'completed')
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.ok(posts.some((u) => u.endsWith(`/phases/${PHASE_1}/integrate`)))
    assert.ok(posts.some((u) => u.endsWith(`/phases/${PHASE_1}/audit`)))
  })

  it('returns blocked when a task is blocked', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'blocked', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'blocked']]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOpts,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'blocked')
    // No /integrate posted — task gate prevents it.
    assert.ok(
      !state.calls.some(
        (c) => c.method === 'POST' && c.url.endsWith(`/phases/${PHASE_1}/integrate`),
      ),
    )
  })

  it('returns blocked when phase audit blocks', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_1}/audit`,
          (s) => s.phases.set(PHASE_1, 'blocked'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOpts,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'blocked')
    assert.ok(deps.errs.some((l) => l.includes('override-audit')))
  })

  it('pauses when an approval is needed under --approve none', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'executing']]),
      approvals: [
        { id: 'a1', subject: 'task', status: 'pending', taskId: TASK_A, riskBand: 'medium' },
      ],
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const opts = { ...baseOpts, approve: 'none' as const }
    const outcome = await drivePhase(
      opts,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'paused')
  })
})

// ---------------------------------------------------------------------------
// runDrive — top-level orchestration
// ---------------------------------------------------------------------------

describe('runDrive', () => {
  it('happy path: drives every phase, completes, releases (exit 0)', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'pending', title: 'A' },
      { id: TASK_B, phaseId: PHASE_2, status: 'pending', title: 'B' },
    ]
    const phaseDefs: DrivenPhase[] = [
      { id: PHASE_1, index: 0, title: 'P1', status: 'executing', mergeOrder: [TASK_A] },
      { id: PHASE_2, index: 1, title: 'P2', status: 'pending', mergeOrder: [TASK_B] },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([
        [TASK_A, 'pending'],
        [TASK_B, 'pending'],
      ]),
      phases: new Map([
        [PHASE_1, 'executing'],
        [PHASE_2, 'pending'],
      ]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [`POST /tasks/${TASK_A}/run`, (s) => s.tasks.set(TASK_A, 'in_review')],
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => s.tasks.set(TASK_A, 'ready_to_merge'),
        ],
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_1}/audit`,
          (s) => {
            s.phases.set(PHASE_1, 'completed')
            // P2 unlocks (the worker would normally bump its status).
            s.phases.set(PHASE_2, 'executing')
          },
        ],
        [`POST /tasks/${TASK_B}/run`, (s) => s.tasks.set(TASK_B, 'in_review')],
        [
          `POST /tasks/${TASK_B}/review`,
          (s) => s.tasks.set(TASK_B, 'ready_to_merge'),
        ],
        [
          `POST /phases/${PHASE_2}/integrate`,
          (s) => s.phases.set(PHASE_2, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_2}/audit`,
          (s) => s.phases.set(PHASE_2, 'completed'),
        ],
        [
          `POST /plans/${PLAN_ID}/complete`,
          (s) => {
            s.completionAudit = 'pass'
          },
        ],
      ]),
    })
    const deps = makeDeps(state)
    const exitCode = await runDrive(baseOpts, deps, FAST_TIMINGS)
    assert.strictEqual(exitCode, 0)
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.ok(posts.some((u) => u.endsWith(`/plans/${PLAN_ID}/complete`)))
    // Release MUST be the last POST issued.
    const releaseIdx = posts.findIndex((u) => u.endsWith(`/plans/${PLAN_ID}/release`))
    assert.ok(releaseIdx >= 0, 'release should have been posted')
    assert.strictEqual(releaseIdx, posts.length - 1, 'release should be the final POST')
  })

  it('exits non-zero (3) when completion audit comes back blocked', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      { id: PHASE_1, index: 0, title: 'P1', status: 'completed', mergeOrder: [TASK_A] },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'completed']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /plans/${PLAN_ID}/complete`,
          (s) => {
            s.completionAudit = 'blocked'
          },
        ],
      ]),
    })
    const deps = makeDeps(state)
    const exitCode = await runDrive(baseOpts, deps, FAST_TIMINGS)
    assert.strictEqual(exitCode, 3)
    // /release must NOT be posted when the audit blocked.
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.ok(!posts.some((u) => u.endsWith(`/plans/${PLAN_ID}/release`)))
  })

  it('exits 1 when a phase task is blocked', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'blocked', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      { id: PHASE_1, index: 0, title: 'P1', status: 'executing', mergeOrder: [TASK_A] },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'blocked']]),
      phases: new Map([[PHASE_1, 'executing']]),
    })
    const deps = makeDeps(state)
    const exitCode = await runDrive(baseOpts, deps, FAST_TIMINGS)
    assert.strictEqual(exitCode, 1)
    // Neither /complete nor /release should fire when a task blocks.
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    assert.ok(!posts.some((u) => u.endsWith('/complete')))
    assert.ok(!posts.some((u) => u.endsWith('/release')))
  })
})

// ---------------------------------------------------------------------------
// driveCli — argv → exit code
// ---------------------------------------------------------------------------

describe('driveCli', () => {
  it('prints DRIVE_USAGE and returns 0 on --help', async () => {
    const logs: string[] = []
    const errs: string[] = []
    const code = await driveCli({
      argv: ['--help'],
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      buildDriveDeps: () => {
        throw new Error('should not be called for --help')
      },
    })
    assert.strictEqual(code, 0)
    assert.ok(logs.join('\n').includes('Usage: pm-go drive'))
  })

  it('returns 2 on argv error', async () => {
    const logs: string[] = []
    const errs: string[] = []
    const code = await driveCli({
      argv: [],
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      buildDriveDeps: () => {
        throw new Error('should not be called on argv error')
      },
    })
    assert.strictEqual(code, 2)
    // Both error message and usage are echoed.
    assert.ok(errs.some((l) => l.includes('--plan')))
  })
})

// ---------------------------------------------------------------------------
// v0.8.4.1 reviewer fixes — regression tests
// ---------------------------------------------------------------------------

const baseOptsForRegression = {
  planId: PLAN_ID,
  apiUrl: API_URL,
  approve: 'all' as const,
}

describe('v0.8.4.1 P1.1: drivePhase polls approvals during integration wait', () => {
  it('--approve all auto-resolves an approval that opens during /integrate, before phase flips to auditing', async () => {
    // Scenario: PhaseIntegrationWorkflow opens a pending approval row
    // BEFORE flipping the phase from executing → integrating →
    // auditing. Drive's old wait predicate (auditing/completed/blocked/
    // failed) skipped that window. The fix: combined wait helper polls
    // approvals every tick, so --approve all flips the row and the
    // workflow can advance.
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'executing']]),
      // /integrate opens the pending approval but does NOT flip
      // phase status (it stays 'executing' until approval is resolved).
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => {
            s.approvals = [
              {
                id: 'a-late',
                subject: 'task',
                status: 'pending',
                taskId: TASK_A,
                riskBand: 'medium',
              },
            ]
            // Phase stays 'executing' until approve-all-pending fires.
          },
        ],
        // When approve-all-pending fires, the workflow can advance
        // and the phase moves to auditing.
        [
          `POST /plans/${PLAN_ID}/approve-all-pending`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_1}/audit`,
          (s) => s.phases.set(PHASE_1, 'completed'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOptsForRegression,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'completed')
    // The approve-all-pending POST happened before the phase reached
    // a terminal state — that's the whole point of the fix.
    const calls = state.calls.map((c) => `${c.method} ${c.url}`)
    const integrateIdx = calls.indexOf(
      `POST ${API_URL}/phases/${PHASE_1}/integrate`,
    )
    const approveIdx = calls.indexOf(
      `POST ${API_URL}/plans/${PLAN_ID}/approve-all-pending`,
    )
    assert.ok(integrateIdx >= 0 && approveIdx >= 0, 'both calls fired')
    assert.ok(
      approveIdx > integrateIdx,
      'approve happens after integrate but before phase transition',
    )
  })
})

describe('v0.8.4.1 P1.2: runDrive maps phase exceptions to EXIT_BLOCKED', () => {
  it('a thrown error inside drivePhase becomes EXIT_BLOCKED with an actionable log', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'executing']]),
    })
    const deps = makeDeps(state)
    // Force the per-phase refresh fetch to throw — simulating a 5xx
    // mid-drive that would otherwise escape past runDrive.
    //
    // As of the v0.8.6+ identity probe (`probePmGoApi`) the call
    // sequence is:
    //   1. GET /health   — the probe (succeeds with the default
    //                       identity envelope from makeState/handle).
    //   2. GET /plans/.. — the initial plan load (succeeds).
    //   3. GET /plans/.. — the per-phase refresh inside the loop.
    // We want #3 to throw so the failure is caught inside the
    // per-phase try/catch (which is where the "drive failed: …" +
    // "inspect via GET …" log pattern lives).
    let calls = 0
    const origFetch = deps.fetch
    deps.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      calls += 1
      if (calls === 3) {
        throw new Error('synthetic 5xx from API')
      }
      return origFetch(...args)
    }) as typeof globalThis.fetch

    const code = await runDrive(baseOptsForRegression, deps, FAST_TIMINGS)
    assert.strictEqual(code, 1) // EXIT_BLOCKED
    assert.ok(
      deps.errs.some((l) => l.includes('drive failed: synthetic 5xx')),
      'should log the underlying error message',
    )
    assert.ok(
      deps.errs.some((l) => l.includes('inspect via GET')),
      'should log an actionable next step',
    )
  })
})

describe('v0.8.4.1 P2.1: drivePhase falls back to task-list order when mergeOrder is empty', () => {
  it('runs every task instead of skipping straight to integration', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'pending', title: 'A' },
      { id: TASK_B, phaseId: PHASE_1, status: 'pending', title: 'B' },
    ]
    // Empty mergeOrder despite having tasks — bug in upstream planner.
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([
        [TASK_A, 'pending'],
        [TASK_B, 'pending'],
      ]),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [`POST /tasks/${TASK_A}/run`, (s) => s.tasks.set(TASK_A, 'in_review')],
        [
          `POST /tasks/${TASK_A}/review`,
          (s) => s.tasks.set(TASK_A, 'ready_to_merge'),
        ],
        [`POST /tasks/${TASK_B}/run`, (s) => s.tasks.set(TASK_B, 'in_review')],
        [
          `POST /tasks/${TASK_B}/review`,
          (s) => s.tasks.set(TASK_B, 'ready_to_merge'),
        ],
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'auditing'),
        ],
        [
          `POST /phases/${PHASE_1}/audit`,
          (s) => s.phases.set(PHASE_1, 'completed'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOptsForRegression,
      { ...phaseDefs[0]! },
      taskDefs,
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'completed')
    // Both tasks got their /run call — the fix exercised the fallback.
    const calls = state.calls.map((c) => `${c.method} ${c.url}`)
    assert.ok(calls.includes(`POST ${API_URL}/tasks/${TASK_A}/run`))
    assert.ok(calls.includes(`POST ${API_URL}/tasks/${TASK_B}/run`))
    // And the operator was warned about the malformed plan.
    assert.ok(
      deps.errs.some(
        (l) =>
          l.includes('empty mergeOrder') ||
          l.includes('falling back to task-list order'),
      ),
      'should log a malformed-plan warning',
    )
  })

  it('does NOT trigger the warning when phase is genuinely empty', async () => {
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [],
      },
    ]
    const state = makeState({
      taskDefs: [],
      phaseDefs,
      tasks: new Map(),
      phases: new Map([[PHASE_1, 'executing']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /phases/${PHASE_1}/integrate`,
          (s) => s.phases.set(PHASE_1, 'completed'),
        ],
      ]),
    })
    const deps = makeDeps(state)
    const outcome = await drivePhase(
      baseOptsForRegression,
      { ...phaseDefs[0]! },
      [],
      FAST_TIMINGS,
      deps,
    )
    assert.strictEqual(outcome, 'completed')
    assert.ok(
      !deps.errs.some((l) => l.includes('empty mergeOrder')),
      'should NOT warn when there are zero tasks',
    )
  })
})

describe('v0.8.4.1 P2.2: runDrive returns EXIT_PAUSED (4) for paused phases', () => {
  it('returns 4 (not 1) when a phase pauses on a declined approval', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      {
        id: PHASE_1,
        index: 0,
        title: 'Phase 1',
        status: 'executing',
        mergeOrder: [TASK_A],
      },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'executing']]),
      approvals: [
        {
          id: 'a1',
          subject: 'task',
          status: 'pending',
          taskId: TASK_A,
          riskBand: 'medium',
        },
      ],
      // Phase doesn't progress while waiting; paused approval propagates.
      onPost: new Map<string, (s: MockServerState) => void>([
        [`POST /phases/${PHASE_1}/integrate`, (_s) => undefined],
      ]),
    })
    const deps = makeDeps(state)
    const opts = { ...baseOptsForRegression, approve: 'none' as const }
    const code = await runDrive(opts, deps, FAST_TIMINGS)
    assert.strictEqual(code, 4) // EXIT_PAUSED
  })
})

// ---------------------------------------------------------------------------
// ac-health-identity-3: identity probe gate at the top of runDrive.
// ---------------------------------------------------------------------------

describe('ac-health-identity-3: runDrive identity probe', () => {
  it('foreign service on /health → exit 1, [pm-go] port prefix, no plan/approval requests', async () => {
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'pending', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      { id: PHASE_1, index: 0, title: 'P1', status: 'executing', mergeOrder: [TASK_A] },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'pending']]),
      phases: new Map([[PHASE_1, 'executing']]),
      // Foreign service: 200 with body that lacks a `service` field.
      healthIdentity: 'foreign',
    })
    const deps = makeDeps(state)
    const exitCode = await runDrive(baseOpts, deps, FAST_TIMINGS)
    assert.strictEqual(exitCode, 1)
    // First-line greppable prefix is on stderr (errLog).
    const firstErr = deps.errs[0] ?? ''
    assert.match(
      firstErr,
      /^\[pm-go\] port 3001 is held by another service/,
      `expected greppable prefix on the first stderr line, got: ${JSON.stringify(firstErr)}`,
    )
    // No plan / approval / run / review / fix / integrate / audit /
    // complete / release request was issued — only /health and nothing
    // else. The probe MUST short-circuit the rest of runDrive.
    const nonHealthCalls = state.calls.filter((c) => !c.url.endsWith('/health'))
    assert.deepStrictEqual(
      nonHealthCalls,
      [],
      `runDrive must not issue any plan/approval request against a foreign API; got: ${JSON.stringify(nonHealthCalls)}`,
    )
  })

  it('matching pm-go on --port 3011 → succeeds exactly as before', async () => {
    // Plan with a single ready_to_merge task, a pre-completed phase, and
    // a passing completion audit — the shortest happy path through
    // runDrive. The point of this test is that a probePmGoApi success
    // does not change any subsequent behaviour.
    const taskDefs: DrivenTask[] = [
      { id: TASK_A, phaseId: PHASE_1, status: 'ready_to_merge', title: 'A' },
    ]
    const phaseDefs: DrivenPhase[] = [
      { id: PHASE_1, index: 0, title: 'P1', status: 'completed', mergeOrder: [TASK_A] },
    ]
    const state = makeState({
      taskDefs,
      phaseDefs,
      tasks: new Map([[TASK_A, 'ready_to_merge']]),
      phases: new Map([[PHASE_1, 'completed']]),
      onPost: new Map<string, (s: MockServerState) => void>([
        [
          `POST /plans/${PLAN_ID}/complete`,
          (s) => {
            s.completionAudit = 'pass'
          },
        ],
      ]),
      // Default healthIdentity = 'pm-go' — the matching identity.
    })
    const deps = makeDeps(state)
    // `pm-go drive --port 3011` resolves to apiUrl http://localhost:3011.
    const optsFor3011 = { ...baseOpts, apiUrl: 'http://localhost:3011' }
    const exitCode = await runDrive(optsFor3011, deps, FAST_TIMINGS)
    assert.strictEqual(exitCode, 0)
    // Probe URL reflects the chosen port — not the default 3001.
    const probeCall = state.calls.find((c) => c.url.endsWith('/health'))
    assert.ok(probeCall, 'expected at least one /health call')
    assert.strictEqual(probeCall.url, 'http://localhost:3011/health')
    // Release MUST be the final POST issued.
    const posts = state.calls.filter((c) => c.method === 'POST').map((c) => c.url)
    const releaseIdx = posts.findIndex((u) => u.endsWith(`/plans/${PLAN_ID}/release`))
    assert.ok(releaseIdx >= 0, 'release should have been posted')
    assert.strictEqual(releaseIdx, posts.length - 1, 'release should be the final POST')
  })
})

// Acknowledge unused imports the test file accepts as part of the module
// surface but doesn't directly call. (Keeps tsc strict happy if we ever
// drop one of the assertions above.)
void DEFAULT_TIMINGS
