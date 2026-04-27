import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  parseRunArgv,
  deriveTitle,
  buildChildEnv,
  formatPortConflictError,
  runSupervisor,
  type InstanceStateEntry,
  type PortPreflightResult,
  type RunDeps,
  type RunOptions,
} from '../run.js'
import {
  createProcessManager,
  type ProcessManager,
  type ProcessManagerDeps,
} from '../lib/process-manager.js'

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const cwd = '/abs/cwd'
const resolve = (a: string, b: string) => (b.startsWith('/') ? b : `${a}/${b}`)

describe('parseRunArgv', () => {
  it('defaults to cwd as repoRoot when --repo is omitted', () => {
    const r = parseRunArgv([], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, cwd)
    assert.strictEqual(r.options.runtime, 'auto')
    assert.strictEqual(r.options.apiPort, 3001)
    assert.strictEqual(r.options.specPath, undefined)
    assert.strictEqual(r.options.skipDocker, false)
  })

  it('resolves --repo + --spec relative to cwd', () => {
    const r = parseRunArgv(
      ['--repo', '.', '--spec', './examples/golden-path/spec.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/abs/cwd/.')
    assert.strictEqual(
      r.options.specPath,
      '/abs/cwd/./examples/golden-path/spec.md',
    )
  })

  it('passes through absolute paths unchanged', () => {
    const r = parseRunArgv(
      ['--repo', '/srv/proj', '--spec', '/srv/proj/feat.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/srv/proj')
    assert.strictEqual(r.options.specPath, '/srv/proj/feat.md')
  })

  it('rejects unknown flags', () => {
    const r = parseRunArgv(['--bogus'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })

  it('rejects --runtime with an unsupported value', () => {
    const r = parseRunArgv(['--runtime', 'magic'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /one of/)
  })

  it('accepts every valid runtime value', () => {
    for (const mode of ['auto', 'stub', 'sdk', 'claude']) {
      const r = parseRunArgv(['--runtime', mode], cwd, resolve)
      assert.ok(r.ok, `runtime=${mode} should parse`)
      assert.strictEqual(r.options.runtime, mode)
    }
  })

  it('rejects --port outside 1..65535', () => {
    for (const bad of ['0', '99999', '-1', 'abc']) {
      const r = parseRunArgv(['--port', bad], cwd, resolve)
      assert.ok(!r.ok, `port=${bad} should fail`)
    }
  })

  it('parses --skip-docker and --skip-migrate as booleans', () => {
    const r = parseRunArgv(['--skip-docker', '--skip-migrate'], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.skipDocker, true)
    assert.strictEqual(r.options.skipMigrate, true)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseRunArgv([flag], cwd, resolve)
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('reports a missing value for flags that need one', () => {
    const r = parseRunArgv(['--repo'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /--repo/)
  })
})

// ---------------------------------------------------------------------------
// deriveTitle
// ---------------------------------------------------------------------------

describe('deriveTitle', () => {
  it('uses the first H1 from the body', () => {
    const t = deriveTitle('# Add phase detail endpoint\n\nContext...', '/x/y.md')
    assert.strictEqual(t, 'Add phase detail endpoint')
  })

  it('skips H2/H3 when no H1 exists, falling back to filename', () => {
    const t = deriveTitle('## Subhead\n\nbody', '/path/to/spec-file.md')
    assert.strictEqual(t, 'spec-file')
  })

  it('strips file extension from the fallback', () => {
    const t = deriveTitle('no headings here', '/x/feature.markdown')
    assert.strictEqual(t, 'feature')
  })

  it('handles multi-line with H1 not on the first line', () => {
    const t = deriveTitle(
      '<!-- some preamble -->\n\n# Real Title\n\nbody',
      '/x.md',
    )
    assert.strictEqual(t, 'Real Title')
  })

  it('trims the leading whitespace inside an H1', () => {
    const t = deriveTitle('#    Padded   \n', '/x.md')
    assert.strictEqual(t, 'Padded')
  })
})

// ---------------------------------------------------------------------------
// buildChildEnv
// ---------------------------------------------------------------------------

describe('buildChildEnv', () => {
  const baseOptions = {
    repoRoot: '/abs/repo',
    specPath: undefined,
    title: undefined,
    apiPort: 3099,
    databaseUrl: 'postgres://x:y@host/z',
    skipDocker: false,
    skipMigrate: false,
  }

  it('passes DATABASE_URL, API_PORT, and REPO_ROOT to the child', () => {
    const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
    assert.strictEqual(env.DATABASE_URL, 'postgres://x:y@host/z')
    assert.strictEqual(env.API_PORT, '3099')
    assert.strictEqual(env.REPO_ROOT, '/abs/repo')
  })

  it('does NOT set *_RUNTIME when --runtime stub', () => {
    const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
    assert.strictEqual(env.PLANNER_RUNTIME, undefined)
    assert.strictEqual(env.IMPLEMENTER_RUNTIME, undefined)
  })

  it('sets every *_RUNTIME for sdk/claude/auto', () => {
    for (const mode of ['sdk', 'claude', 'auto'] as const) {
      const env = buildChildEnv({ ...baseOptions, runtime: mode })
      assert.strictEqual(env.PLANNER_RUNTIME, mode)
      assert.strictEqual(env.IMPLEMENTER_RUNTIME, mode)
      assert.strictEqual(env.REVIEWER_RUNTIME, mode)
      assert.strictEqual(env.PHASE_AUDITOR_RUNTIME, mode)
      assert.strictEqual(env.COMPLETION_AUDITOR_RUNTIME, mode)
    }
  })

  it('preserves pre-exported per-role *_RUNTIME values for sdk/claude/auto (mixed roles)', () => {
    const original = process.env.PLANNER_RUNTIME
    try {
      process.env.PLANNER_RUNTIME = 'claude'
      const env = buildChildEnv({ ...baseOptions, runtime: 'sdk' })
      // Caller's PLANNER_RUNTIME=claude wins; other roles default to sdk.
      assert.strictEqual(env.PLANNER_RUNTIME, 'claude')
      assert.strictEqual(env.IMPLEMENTER_RUNTIME, 'sdk')
      assert.strictEqual(env.REVIEWER_RUNTIME, 'sdk')
    } finally {
      if (original === undefined) delete process.env.PLANNER_RUNTIME
      else process.env.PLANNER_RUNTIME = original
    }
  })

  it('--runtime stub strips inherited *_RUNTIME so the explicit flag wins (P2.1)', () => {
    const originals: Record<string, string | undefined> = {}
    const keys = [
      'PLANNER_RUNTIME',
      'IMPLEMENTER_RUNTIME',
      'REVIEWER_RUNTIME',
      'PHASE_AUDITOR_RUNTIME',
      'COMPLETION_AUDITOR_RUNTIME',
    ]
    try {
      for (const k of keys) {
        originals[k] = process.env[k]
        process.env[k] = 'sdk'
      }
      const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
      // Every *_RUNTIME must be undefined in the child env, otherwise the
      // worker would resolve to live mode despite the explicit --runtime stub.
      for (const k of keys) {
        assert.strictEqual(
          env[k],
          undefined,
          `${k} should be cleared on --runtime stub but was ${env[k]}`,
        )
      }
    } finally {
      for (const k of keys) {
        if (originals[k] === undefined) delete process.env[k]
        else process.env[k] = originals[k]
      }
    }
  })

  it('--runtime stub also strips legacy *_EXECUTOR_MODE=live (regression: stale .env from dogfood)', () => {
    const originals: Record<string, string | undefined> = {}
    const keys = [
      'PLANNER_EXECUTOR_MODE',
      'IMPLEMENTER_EXECUTOR_MODE',
      'REVIEWER_EXECUTOR_MODE',
      'PHASE_AUDITOR_EXECUTOR_MODE',
      'COMPLETION_AUDITOR_EXECUTOR_MODE',
    ]
    try {
      for (const k of keys) {
        originals[k] = process.env[k]
        process.env[k] = 'live'
      }
      const env = buildChildEnv({ ...baseOptions, runtime: 'stub' })
      for (const k of keys) {
        assert.strictEqual(
          env[k],
          undefined,
          `${k} should be cleared on --runtime stub but was ${env[k]}`,
        )
      }
    } finally {
      for (const k of keys) {
        if (originals[k] === undefined) delete process.env[k]
        else process.env[k] = originals[k]
      }
    }
  })
})

// ---------------------------------------------------------------------------
// runSupervisor: port pre-flight + state-file wiring (T1c integration with
// the T1a state-file primitives — see ac-c08b-1).
// ---------------------------------------------------------------------------

/**
 * Build a RunDeps + RunOptions stub plus a captured ledger of effects.
 * The default deps simulate a healthy stack: every exec returns 0, the
 * spawned worker/api processes never crash, fetch always responds 200,
 * and the API /health probe is reachable on the first poll. Per-test
 * overrides flip individual seams (e.g. `checkPorts` for the conflict
 * test).
 */
function makeSupervisorFixture(overrides: {
  checkPorts?: RunDeps['checkPorts']
  options?: Partial<RunOptions>
} = {}) {
  const execCalls: Array<{ cmd: string; args: readonly string[] }> = []
  const writeStateCalls: InstanceStateEntry[] = []
  const removeStateCalls: number[] = []
  const logs: string[] = []
  const errs: string[] = []

  function makeFakeChild(pid: number) {
    const proc = new EventEmitter() as EventEmitter & {
      pid: number
      stdout: EventEmitter
      stderr: EventEmitter
      kill: (signal?: NodeJS.Signals) => boolean
      exitCode: number | null
      signalCode: NodeJS.Signals | null
    }
    proc.pid = pid
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.exitCode = null
    proc.signalCode = null
    proc.kill = () => true
    return proc
  }

  let nextPid = 1000
  const spawn = (() => {
    const fn = ((_cmd: string, _args: readonly string[]) =>
      makeFakeChild(nextPid++)) as RunDeps['spawn']
    return fn
  })()

  const fakePm: ProcessManager = {
    add: () => undefined,
    shutdown: async () => {
      throw new Error('shutdown should not be called on the happy path')
    },
    stop: async () => {
      removeStateCalls.push(removeStateCalls.length)
    },
    get shuttingDown() {
      return false
    },
  }

  const deps: RunDeps = {
    exec: async (cmd, args) => {
      execCalls.push({ cmd, args: [...args] })
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn,
    fetch: (async () =>
      ({
        ok: true,
        async text() {
          return ''
        },
        async json() {
          return {}
        },
      } as unknown as Response)) as unknown as typeof globalThis.fetch,
    readFile: async () => '',
    fileExists: async () => true,
    mkdir: async () => undefined,
    now: () => 0,
    sleep: async () => undefined,
    log: (l) => logs.push(l),
    errLog: (l) => errs.push(l),
    pm: fakePm,
    monorepoRoot: '/abs/monorepo',
    checkPorts: overrides.checkPorts ?? (async () => ({ ok: true } as PortPreflightResult)),
    writeInstanceState: async (entry) => {
      writeStateCalls.push(entry)
    },
    processPid: 9999,
  }

  const options: RunOptions = {
    repoRoot: '/abs/repo',
    specPath: undefined,
    title: undefined,
    runtime: 'stub',
    apiPort: 3001,
    databaseUrl: 'postgres://x:y@host/z',
    skipDocker: false,
    skipMigrate: true,
    ...overrides.options,
  }

  return { deps, options, execCalls, writeStateCalls, removeStateCalls, logs, errs }
}

describe('runSupervisor port pre-flight + state file', () => {
  it('invokes checkPorts with [5432, 7233, 8233, apiPort] BEFORE any docker compose up', async () => {
    let portsArg: readonly number[] | undefined
    let portsCheckOrder: number = -1
    let dockerComposeUpOrder: number = -1
    let counter = 0
    const { deps, options } = makeSupervisorFixture({
      checkPorts: async (ports) => {
        portsArg = ports
        portsCheckOrder = ++counter
        return { ok: true }
      },
      options: { apiPort: 3099 },
    })
    const origExec = deps.exec
    deps.exec = async (cmd, args, opts) => {
      if (cmd === 'docker' && args[0] === 'compose' && args[1] === 'up') {
        dockerComposeUpOrder = ++counter
      }
      return origExec(cmd, args, opts)
    }
    // Provide an onReady that returns 0 so the supervisor doesn't block.
    await runSupervisor(options, deps, async () => 0)
    assert.deepEqual(portsArg, [5432, 7233, 8233, 3099])
    assert.notStrictEqual(portsCheckOrder, -1, 'checkPorts must run')
    assert.notStrictEqual(dockerComposeUpOrder, -1, 'docker compose up must run')
    assert.ok(
      portsCheckOrder < dockerComposeUpOrder,
      `checkPorts (#${portsCheckOrder}) must precede docker compose up (#${dockerComposeUpOrder})`,
    )
  })

  it('writeInstanceState fires for supervisor + worker + api ONLY after httpReady resolves', async () => {
    const observedOrder: string[] = []
    const fixture = makeSupervisorFixture()
    const origFetch = fixture.deps.fetch
    let healthSeen = false
    fixture.deps.fetch = (async (url: unknown, init?: unknown) => {
      const u =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.toString()
            : (url as { url: string }).url
      if (u.endsWith('/health')) {
        healthSeen = true
        observedOrder.push('httpReady')
      }
      return (origFetch as unknown as (a: unknown, b: unknown) => Promise<unknown>)(
        u,
        init,
      )
    }) as unknown as typeof globalThis.fetch
    fixture.deps.writeInstanceState = async (entry) => {
      // Write must happen AFTER the /health probe — the test asserts
      // the order below.
      assert.ok(
        healthSeen,
        `writeInstanceState ran for ${entry.label} BEFORE httpReady — premature persistence`,
      )
      observedOrder.push(`write:${entry.label}`)
      fixture.writeStateCalls.push(entry)
    }
    await runSupervisor(fixture.options, fixture.deps, async () => 0)
    const labels = fixture.writeStateCalls.map((e) => e.label)
    assert.deepEqual(labels, ['supervisor', 'worker', 'api'])
    // supervisor pid is the injected one
    assert.strictEqual(fixture.writeStateCalls[0]?.pid, 9999)
    // ordering sanity: every write happened after the health probe
    const firstWriteIdx = observedOrder.findIndex((s) => s.startsWith('write:'))
    const httpReadyIdx = observedOrder.indexOf('httpReady')
    assert.ok(
      httpReadyIdx >= 0 && firstWriteIdx > httpReadyIdx,
      `httpReady (${httpReadyIdx}) must precede first writeInstanceState (${firstWriteIdx})`,
    )
  })

  it('a non-pm-go port conflict produces the documented remediation string and a non-zero exit BEFORE docker is touched', async () => {
    const dockerCalls: Array<{ cmd: string; args: readonly string[] }> = []
    const { deps, options, errs } = makeSupervisorFixture({
      checkPorts: async () => ({
        ok: false,
        conflicts: [{ port: 5432, pid: 12345, owner: 'unknown' }],
      }),
    })
    const origExec = deps.exec
    deps.exec = async (cmd, args, opts) => {
      if (cmd === 'docker') dockerCalls.push({ cmd, args: [...args] })
      return origExec(cmd, args, opts)
    }
    const code = await runSupervisor(options, deps)
    assert.notStrictEqual(code, 0, 'expected non-zero exit on port conflict')
    assert.strictEqual(dockerCalls.length, 0, 'docker must not be touched on conflict')
    // Exact remediation string the operator will see.
    const expected = formatPortConflictError([
      { port: 5432, pid: 12345, owner: 'unknown' },
    ])
    assert.ok(
      errs.includes(expected),
      `errLog must contain exact remediation:\n${expected}\n\nactual:\n${errs.join('\n')}`,
    )
  })
})

// ---------------------------------------------------------------------------
// process-manager: removeInstanceState fires from stop() AND shutdown()
// (the AC mandates BOTH paths, see ac-c08b-1 (iii) and ac-c08b-4).
// ---------------------------------------------------------------------------

describe('processManager removeInstanceState wiring', () => {
  function makeFakeProcess(): Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid'> {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
    return {
      pid: 4242,
      on(ev: string | symbol, listener: (...args: unknown[]) => void) {
        const key = String(ev)
        let s = handlers.get(key)
        if (!s) {
          s = new Set()
          handlers.set(key, s)
        }
        s.add(listener)
        return this as unknown as NodeJS.Process
      },
      off(ev: string | symbol, listener: (...args: unknown[]) => void) {
        handlers.get(String(ev))?.delete(listener)
        return this as unknown as NodeJS.Process
      },
      kill: () => true,
    } as Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid'>
  }

  it('stop() invokes removeInstanceState exactly once', async () => {
    let callCount = 0
    const deps: ProcessManagerDeps = {
      process: makeFakeProcess(),
      log: () => undefined,
      removeInstanceState: async () => {
        callCount++
      },
    }
    const pm = createProcessManager(deps, 0)
    await pm.stop('test')
    assert.strictEqual(callCount, 1)
    // Idempotent: a second stop() does not re-fire.
    await pm.stop('test again')
    assert.strictEqual(callCount, 1)
  })

  it('shutdown() invokes removeInstanceState before process.exit', async () => {
    let callCount = 0
    const exits: number[] = []
    const origExit = process.exit
    // Stub process.exit so the test process survives. Cast through
    // unknown to satisfy the (never)-returning signature.
    process.exit = ((code?: number) => {
      exits.push(code ?? 0)
      throw new Error(`__exit_${code}`)
    }) as unknown as typeof process.exit
    try {
      const deps: ProcessManagerDeps = {
        process: makeFakeProcess(),
        log: () => undefined,
        removeInstanceState: async () => {
          callCount++
        },
      }
      const pm = createProcessManager(deps, 0)
      // shutdown's signature is `Promise<never>`; it throws via our
      // stubbed exit. Catch so the test can assert.
      await pm.shutdown('SIGINT', 130).catch((e) => {
        if (!(e instanceof Error) || !e.message.startsWith('__exit_')) throw e
      })
      assert.strictEqual(callCount, 1)
      assert.deepEqual(exits, [130])
    } finally {
      process.exit = origExit
    }
  })

  it('removeInstanceState is optional — stop() succeeds without it', async () => {
    const deps: ProcessManagerDeps = {
      process: makeFakeProcess(),
      log: () => undefined,
    }
    const pm = createProcessManager(deps, 0)
    await pm.stop('no-state')
  })
})
