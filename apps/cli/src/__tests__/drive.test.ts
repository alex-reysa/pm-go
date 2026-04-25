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

// Acknowledge unused imports the test file accepts as part of the module
// surface but doesn't directly call. (Keeps tsc strict happy if we ever
// drop one of the assertions above.)
void DEFAULT_TIMINGS
