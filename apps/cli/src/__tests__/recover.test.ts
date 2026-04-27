import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import {
  parseRecoverArgv,
  runRecover,
  diagnoseRecovery,
  renderManualHint,
  shellQuotePath,
  type RecoverDeps,
  type WorkflowDescription,
} from '../recover.js'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const VALID_UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'

interface FakeRecoverOpts {
  /** Response shape for `${apiUrl}/health`. */
  health?: 'ok' | 'fail-status' | 'throw'
  /** Response shape for `${apiUrl}/plans/${planId}`. */
  plan?: { ok: boolean; status?: string } | null
  workflow?: WorkflowDescription
  attachOutcome?: string
  repoRoot?: string
}

interface DepCalls {
  fetchUrls: string[]
  describeCalls: string[]
  attachCalls: { workflowId: string; runId: string }[]
  rerunCalls: string[]
  startCalls: number[]
}

function makeFakeRecover(opts: FakeRecoverOpts = {}): {
  deps: RecoverDeps
  lines: string[]
  calls: DepCalls
} {
  const lines: string[] = []
  const calls: DepCalls = {
    fetchUrls: [],
    describeCalls: [],
    attachCalls: [],
    rerunCalls: [],
    startCalls: [],
  }
  const deps: RecoverDeps = {
    fetch: (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      calls.fetchUrls.push(url)
      if (url.endsWith('/health')) {
        if (opts.health === 'throw') throw new Error('connect ECONNREFUSED')
        const ok = opts.health !== 'fail-status'
        return new Response(ok ? 'ok' : 'no', { status: ok ? 200 : 503 })
      }
      if (url.includes('/plans/')) {
        if (opts.plan === null) {
          throw new Error('plan fetch threw')
        }
        if (!opts.plan) {
          return new Response('not found', { status: 404 })
        }
        const body = JSON.stringify({ plan: { status: opts.plan.status ?? 'unknown' } })
        return new Response(body, {
          status: opts.plan.ok ? 200 : 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('', { status: 404 })
    }) as RecoverDeps['fetch'],
    describeWorkflow: async (planId) => {
      calls.describeCalls.push(planId)
      return opts.workflow ?? { status: 'not_found' }
    },
    attachAndWait: async (workflowId, runId) => {
      calls.attachCalls.push({ workflowId, runId })
      return { outcome: opts.attachOutcome ?? 'pass' }
    },
    rerunProjection: async (planId) => {
      calls.rerunCalls.push(planId)
    },
    startSupervisor: async (apiPort) => {
      calls.startCalls.push(apiPort)
    },
    repoRoot: opts.repoRoot ?? '/srv/proj',
    write: (l) => lines.push(l),
  }
  return { deps, lines, calls }
}

const baseOptions = (overrides: Partial<{
  planId: string
  apiUrl: string
  dryRun: boolean
}> = {}) => ({
  planId: VALID_UUID,
  apiUrl: 'http://localhost:3001',
  dryRun: false,
  ...overrides,
})

// ---------------------------------------------------------------------------
// parseRecoverArgv
// ---------------------------------------------------------------------------

describe('parseRecoverArgv', () => {
  it('accepts --plan <uuid> + --dry-run', () => {
    const r = parseRecoverArgv(['--plan', VALID_UUID, '--dry-run'])
    assert.ok(r.ok)
    assert.strictEqual(r.options.planId, VALID_UUID)
    assert.strictEqual(r.options.dryRun, true)
    assert.strictEqual(r.options.apiUrl, 'http://localhost:3001')
  })

  it('rejects malformed UUIDs', () => {
    const r = parseRecoverArgv(['--plan', 'not-a-uuid'])
    assert.ok(!r.ok)
    assert.match(r.error, /must be a UUID/)
  })

  it('requires --plan', () => {
    const r = parseRecoverArgv([])
    assert.ok(!r.ok)
    assert.match(r.error, /--plan/)
  })

  it('returns help signal on -h / --help', () => {
    for (const flag of ['-h', '--help']) {
      const r = parseRecoverArgv([flag])
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('overrides port via --port and --api-url', () => {
    const r1 = parseRecoverArgv(['--plan', VALID_UUID, '--port', '4002'])
    assert.ok(r1.ok)
    assert.strictEqual(r1.options.apiUrl, 'http://localhost:4002')
    const r2 = parseRecoverArgv([
      '--plan',
      VALID_UUID,
      '--api-url',
      'http://api.local:8080/',
    ])
    assert.ok(r2.ok)
    assert.strictEqual(r2.options.apiUrl, 'http://api.local:8080')
  })

  it('rejects unknown flags', () => {
    const r = parseRecoverArgv(['--plan', VALID_UUID, '--bogus'])
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })
})

// ---------------------------------------------------------------------------
// diagnoseRecovery — four branches
// ---------------------------------------------------------------------------

describe('diagnoseRecovery', () => {
  it('API down → branch=api-down', async () => {
    const { deps } = makeFakeRecover({ health: 'throw' })
    const r = await diagnoseRecovery(baseOptions(), deps)
    assert.strictEqual(r.branch, 'api-down')
  })

  it('API up + workflow=running → branch=running-workflow', async () => {
    const { deps } = makeFakeRecover({
      workflow: { status: 'running', workflowId: 'wf-1', runId: 'run-1' },
    })
    const r = await diagnoseRecovery(baseOptions(), deps)
    assert.strictEqual(r.branch, 'running-workflow')
    assert.strictEqual(r.workflow?.workflowId, 'wf-1')
  })

  it('API up + workflow=completed + plan!=released → branch=completed-unprojected', async () => {
    const { deps } = makeFakeRecover({
      workflow: { status: 'completed', workflowId: 'wf-1', runId: 'run-1' },
      plan: { ok: true, status: 'executing' },
    })
    const r = await diagnoseRecovery(baseOptions(), deps)
    assert.strictEqual(r.branch, 'completed-unprojected')
  })

  it('API up + workflow=not_found → branch=nothing-salvageable', async () => {
    const { deps } = makeFakeRecover({
      workflow: { status: 'not_found' },
    })
    const r = await diagnoseRecovery(baseOptions(), deps)
    assert.strictEqual(r.branch, 'nothing-salvageable')
  })

  it('API up + workflow=failed → branch=nothing-salvageable', async () => {
    const { deps } = makeFakeRecover({
      workflow: { status: 'failed', workflowId: 'wf-1', runId: 'run-1' },
    })
    const r = await diagnoseRecovery(baseOptions(), deps)
    assert.strictEqual(r.branch, 'nothing-salvageable')
  })
})

// ---------------------------------------------------------------------------
// runRecover — wires each branch to the right side-effect dep
// ---------------------------------------------------------------------------

describe('runRecover', () => {
  it('api-down: invokes startSupervisor with the parsed apiPort', async () => {
    const { deps, calls } = makeFakeRecover({ health: 'throw' })
    const code = await runRecover(baseOptions({ apiUrl: 'http://localhost:4002' }), deps)
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls.startCalls, [4002])
    assert.strictEqual(calls.attachCalls.length, 0)
    assert.strictEqual(calls.rerunCalls.length, 0)
  })

  it('running-workflow: invokes attachAndWait with workflowId+runId', async () => {
    const { deps, calls, lines } = makeFakeRecover({
      workflow: { status: 'running', workflowId: 'wf-1', runId: 'run-1' },
      attachOutcome: 'pass',
    })
    const code = await runRecover(baseOptions(), deps)
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls.attachCalls, [
      { workflowId: 'wf-1', runId: 'run-1' },
    ])
    assert.strictEqual(calls.startCalls.length, 0)
    assert.strictEqual(calls.rerunCalls.length, 0)
    assert.match(lines.join('\n'), /pass/)
  })

  it('completed-unprojected: invokes rerunProjection with the planId', async () => {
    const { deps, calls } = makeFakeRecover({
      workflow: { status: 'completed', workflowId: 'wf-1', runId: 'run-1' },
      plan: { ok: true, status: 'executing' },
    })
    const code = await runRecover(baseOptions(), deps)
    assert.strictEqual(code, 0)
    assert.deepStrictEqual(calls.rerunCalls, [VALID_UUID])
    assert.strictEqual(calls.startCalls.length, 0)
    assert.strictEqual(calls.attachCalls.length, 0)
  })

  it('nothing-salvageable: prints manual hint with shell-quoted repo path; exits 1', async () => {
    const { deps, calls, lines } = makeFakeRecover({
      workflow: { status: 'not_found' },
      repoRoot: '/tmp/with space/repo',
    })
    const code = await runRecover(baseOptions(), deps)
    assert.strictEqual(code, 1)
    assert.strictEqual(calls.startCalls.length, 0)
    assert.strictEqual(calls.attachCalls.length, 0)
    assert.strictEqual(calls.rerunCalls.length, 0)
    const out = lines.join('\n')
    assert.match(out, /No automatic recovery available/)
    assert.match(out, /'\/tmp\/with space\/repo'/)
  })

  // --------------------------------------------------------------------
  // ac-bf7a-3: --dry-run never invokes side-effect deps
  // --------------------------------------------------------------------

  it('--dry-run on api-down branch never calls startSupervisor', async () => {
    const { deps, calls, lines } = makeFakeRecover({ health: 'throw' })
    const code = await runRecover(baseOptions({ dryRun: true }), deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(calls.startCalls.length, 0)
    assert.match(lines.join('\n'), /dry-run/)
  })

  it('--dry-run on running-workflow branch never calls attachAndWait', async () => {
    const { deps, calls } = makeFakeRecover({
      workflow: { status: 'running', workflowId: 'wf-1', runId: 'run-1' },
    })
    const code = await runRecover(baseOptions({ dryRun: true }), deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(calls.attachCalls.length, 0)
  })

  it('--dry-run on completed-unprojected branch never calls rerunProjection', async () => {
    const { deps, calls } = makeFakeRecover({
      workflow: { status: 'completed', workflowId: 'wf-1', runId: 'run-1' },
      plan: { ok: true, status: 'executing' },
    })
    const code = await runRecover(baseOptions({ dryRun: true }), deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(calls.rerunCalls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// shellQuotePath + manual-hint round-trip
// ---------------------------------------------------------------------------

describe('shellQuotePath', () => {
  it('wraps a simple path in single-quotes', () => {
    assert.strictEqual(shellQuotePath('/srv/proj'), `'/srv/proj'`)
  })

  it('escapes embedded single-quotes with the canonical dance', () => {
    assert.strictEqual(
      shellQuotePath(`/srv/it's mine/repo`),
      `'/srv/it'\\''s mine/repo'`,
    )
  })

  it('handles paths with spaces (the dogfood example)', () => {
    assert.strictEqual(
      shellQuotePath('/tmp/with space/repo'),
      `'/tmp/with space/repo'`,
    )
  })
})

// ac-bf7a-4: feed `/tmp/with space/repo` through the manual hint and
// verify the resulting command parses cleanly through `sh -c`.
describe('renderManualHint shell round-trip', () => {
  it('produces a `pm-go run --repo …` line a shell can tokenise back to the original path', () => {
    const lines = renderManualHint(
      { planId: VALID_UUID, apiUrl: 'http://localhost:3001', dryRun: false },
      '/tmp/with space/repo',
    )
    const runLine = lines.find((l) => l.includes('pm-go run')) ?? ''
    assert.ok(runLine.includes(`'/tmp/with space/repo'`), runLine)

    // Pull just the args to --repo and parse them through the shell.
    // We use `printf %s` so the shell expands the quoting and prints
    // the original path back; this is the exact test the AC asks for.
    const match = runLine.match(/pm-go run --repo (.+)$/)
    assert.ok(match, `expected --repo segment in: ${runLine}`)
    const quoted = match![1]!.trim()
    const out = execFileSync('sh', ['-c', `printf %s ${quoted}`], {
      encoding: 'utf8',
    })
    assert.strictEqual(out, '/tmp/with space/repo')
  })
})
