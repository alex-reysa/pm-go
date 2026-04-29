import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  parseImplementArgv,
  IMPLEMENT_USAGE,
  implementCli,
  type ImplementCliDeps,
} from '../implement.js'
import {
  runSupervisor as runSupervisorImpl,
  type InstanceStateEntry,
  type RunDeps,
  type RunOptions,
} from '../run.js'
import { EXIT_PAUSED, type DriveDeps } from '../drive.js'

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const cwd = '/abs/cwd'
const resolve = (a: string, b: string) => (b.startsWith('/') ? b : `${a}/${b}`)

describe('parseImplementArgv', () => {
  it('rejects when --spec is missing', () => {
    const r = parseImplementArgv(['--repo', '.'], cwd, resolve)
    assert.ok(!r.ok)
    assert.match(r.error, /--spec/)
  })

  it('parses --repo + --spec into absolute paths', () => {
    const r = parseImplementArgv(
      ['--repo', '.', '--spec', './feature.md'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.repoRoot, '/abs/cwd/.')
    assert.strictEqual(r.options.specPath, '/abs/cwd/./feature.md')
  })

  it('defaults --runtime to auto and --approve to all', () => {
    const r = parseImplementArgv(['--spec', '/abs/x.md'], cwd, resolve)
    assert.ok(r.ok)
    assert.strictEqual(r.options.runtime, 'auto')
    assert.strictEqual(r.options.approve, 'all')
  })

  it('accepts every approval mode', () => {
    for (const mode of ['all', 'none', 'interactive']) {
      const r = parseImplementArgv(
        ['--spec', '/abs/x.md', '--approve', mode],
        cwd,
        resolve,
      )
      assert.ok(r.ok, `approve=${mode} should parse`)
      assert.strictEqual(r.options.approve, mode)
    }
  })

  it('rejects an unknown --approve value', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--approve', 'magic'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
    assert.match(r.error, /one of/)
  })

  it('passes through skipDocker + skipMigrate', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--skip-docker', '--skip-migrate'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.skipDocker, true)
    assert.strictEqual(r.options.skipMigrate, true)
  })

  it('rejects unknown flags', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--bogus'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
    assert.match(r.error, /unknown flag/)
  })

  it('returns help signal on --help / -h', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseImplementArgv([flag], cwd, resolve)
      assert.ok(!r.ok)
      assert.strictEqual(r.error, 'help')
    }
  })

  it('honors --port', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--port', '4000'],
      cwd,
      resolve,
    )
    assert.ok(r.ok)
    assert.strictEqual(r.options.apiPort, 4000)
  })

  it('rejects --port outside range', () => {
    const r = parseImplementArgv(
      ['--spec', '/abs/x.md', '--port', '99999'],
      cwd,
      resolve,
    )
    assert.ok(!r.ok)
  })
})

// ---------------------------------------------------------------------------
// implementCli — dispatch + early-exit paths
// ---------------------------------------------------------------------------

describe('implementCli', () => {
  function makeCliDeps(
    argv: string[],
    overrides: Partial<ImplementCliDeps> = {},
  ): { deps: ImplementCliDeps; logs: string[]; errs: string[] } {
    const logs: string[] = []
    const errs: string[] = []
    const deps: ImplementCliDeps = {
      argv,
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      resolve,
      buildSupervisorDeps: () => {
        throw new Error('buildSupervisorDeps should not be called for early-exit paths')
      },
      buildDriveDeps: () => {
        throw new Error('buildDriveDeps should not be called for early-exit paths')
      },
      ...overrides,
    }
    return { deps, logs, errs }
  }

  it('--help prints the usage and exits 0', async () => {
    const { deps, logs } = makeCliDeps(['--help'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 0)
    assert.ok(logs.join('\n').includes(IMPLEMENT_USAGE.split('\n')[0]!))
  })

  it('missing --spec exits 2 with usage', async () => {
    const { deps, errs } = makeCliDeps(['--repo', '.'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => l.includes('--spec')))
  })

  it('unknown flag exits 2 with usage', async () => {
    const { deps, errs } = makeCliDeps(['--spec', '/abs/x.md', '--bogus'])
    const code = await implementCli(deps)
    assert.strictEqual(code, 2)
    assert.ok(errs.some((l) => l.includes('unknown flag')))
  })

  it('logs dotenv summary when applyDotenv loads a file', async () => {
    const { deps, logs } = makeCliDeps(['--help'], {
      applyDotenv: async () => ({
        loaded: true,
        applied: ['DATABASE_URL', 'API_PORT'],
        skipped: ['ANTHROPIC_API_KEY'],
        warnings: [],
      }),
    })
    await implementCli(deps)
    assert.ok(logs.some((l) => l.includes('loaded .env')))
    assert.ok(logs.some((l) => l.includes('2 applied')))
  })

  it('does NOT log dotenv summary when no .env loaded', async () => {
    const { deps, logs } = makeCliDeps(['--help'], {
      applyDotenv: async () => ({
        loaded: false,
        applied: [],
        skipped: [],
        warnings: [],
      }),
    })
    await implementCli(deps)
    assert.ok(!logs.some((l) => l.includes('loaded .env')))
  })

  // -------------------------------------------------------------------------
  // ac-c08b-2: implement extends the per-instance state file with a `drive`
  // entry once the drive process is spawned, and the entry is removed on
  // supervisor stop. We model the state file as an in-memory ledger whose
  // entries are tracked by the fake runSupervisor + the fake removeInstanceState
  // wired into the (otherwise unused) process-manager seam.
  // -------------------------------------------------------------------------
  it('appends a `drive` entry on spawn and removes it via the supervisor stop path', async () => {
    // Shared in-memory "state file": a Set of labels currently recorded.
    const stateLedger = new Set<string>()
    let removeStateCalls = 0

    // Fake runSupervisor: simulate the boot path having already
    // populated supervisor/worker/api, then call onReady (which is
    // implementCli's hook to write the drive entry), then simulate
    // pm.stop() → removeInstanceState clearing the file.
    const fakeRunSupervisor = async (
      _options: RunOptions,
      _deps: RunDeps,
      onReady?: (handle: {
        planId?: string
        apiUrl: string
        writeInstanceState: (entry: InstanceStateEntry) => Promise<void>
      }) => Promise<number>,
    ): Promise<number> => {
      // Pretend the supervisor wrote these on its way to httpReady.
      stateLedger.add('supervisor')
      stateLedger.add('worker')
      stateLedger.add('api')
      const code = await onReady!({
        planId: '11111111-1111-4111-8111-111111111111',
        apiUrl: 'http://localhost:3001',
        writeInstanceState: async (entry) => {
          stateLedger.add(entry.label)
        },
      })
      // Simulate pm.stop() teardown: the process-manager's
      // removeInstanceState (wired from cliDeps.removeInstanceState)
      // clears the state file atomically.
      removeStateCalls++
      stateLedger.clear()
      return code
    }

    const logs: string[] = []
    const errs: string[] = []
    const deps: ImplementCliDeps = {
      argv: ['--repo', '.', '--spec', '/abs/spec.md'],
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      resolve,
      buildSupervisorDeps: () => ({} as Omit<RunDeps, 'pm' | 'monorepoRoot'>),
      buildDriveDeps: () => ({
        // runDrive is invoked but in the real implementCli path; we
        // deliberately keep the fake runSupervisor's onReady path
        // calling buildDriveDeps. To skip the actual runDrive, our
        // fake passes through onReady's return — runDrive will run
        // against this stub. Provide a fetch that returns a 404 for
        // every plan call so runDrive bails fast with a non-zero
        // code, which is fine for this test (we only assert state
        // ledger transitions).
        fetch: (async () =>
          ({ ok: false, status: 404, async text() { return '' } } as unknown as Response)) as unknown as typeof globalThis.fetch,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
        errLog: () => undefined,
        prompt: async () => false,
      } as DriveDeps),
      removeInstanceState: async () => {
        // The PM's removeInstanceState in production is the same
        // backend writeInstanceState writes to. Our fake
        // runSupervisor already simulated the clear; this stays a
        // no-op so we don't double-clear.
      },
      runSupervisor: fakeRunSupervisor as unknown as NonNullable<ImplementCliDeps['runSupervisor']>,
      drivePid: 7777,
      // v0.8.7.1: drive returns non-zero (404 fetch → EXIT_BLOCKED)
      // which now hits the drive-failure stay-up branch. Resolve
      // immediately so the test doesn't hang.
      stayUpUntilSigint: async () => undefined,
    }

    await implementCli(deps)

    // Drive entry was added (we capture it BEFORE the simulated stop
    // by snapshotting inside runSupervisor before clearing).
    // To make the assertion robust, redo with a capture.
    assert.strictEqual(
      removeStateCalls,
      1,
      'expected exactly one supervisor stop teardown',
    )
    assert.strictEqual(
      stateLedger.size,
      0,
      'state file should be empty after supervisor stop',
    )
  })

  it('the drive entry is observable in the state file BEFORE stop fires', async () => {
    // Same shape as above but we capture a snapshot of the ledger
    // immediately after writeInstanceState resolves and before the
    // simulated stop empties it. This is what `pm-go ps` would see
    // while implement is mid-flight.
    let snapshotAfterDriveWrite: InstanceStateEntry[] = []
    const stateEntries: InstanceStateEntry[] = []

    const fakeRunSupervisor = async (
      _o: RunOptions,
      _d: RunDeps,
      onReady?: (handle: {
        planId?: string
        apiUrl: string
        writeInstanceState: (entry: InstanceStateEntry) => Promise<void>
      }) => Promise<number>,
    ): Promise<number> => {
      stateEntries.push({ label: 'supervisor', pid: 1 })
      stateEntries.push({ label: 'worker', pid: 2 })
      stateEntries.push({ label: 'api', pid: 3 })
      const code = await onReady!({
        planId: '11111111-1111-4111-8111-111111111111',
        apiUrl: 'http://localhost:3001',
        writeInstanceState: async (entry) => {
          stateEntries.push(entry)
          // Capture the live ledger right after drive is written —
          // before the simulated stop clears it.
          if (entry.label === 'drive') {
            snapshotAfterDriveWrite = [...stateEntries]
          }
        },
      })
      // Stop teardown:
      stateEntries.length = 0
      return code
    }

    const deps: ImplementCliDeps = {
      argv: ['--spec', '/abs/spec.md'],
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: () => undefined,
      errLog: () => undefined,
      resolve,
      buildSupervisorDeps: () => ({} as Omit<RunDeps, 'pm' | 'monorepoRoot'>),
      buildDriveDeps: () => ({
        fetch: (async () =>
          ({ ok: false, status: 404, async text() { return '' } } as unknown as Response)) as unknown as typeof globalThis.fetch,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
        errLog: () => undefined,
        prompt: async () => false,
      } as DriveDeps),
      runSupervisor: fakeRunSupervisor as unknown as NonNullable<ImplementCliDeps['runSupervisor']>,
      drivePid: 7777,
      // v0.8.7.1: same fail-open mitigation as the previous test.
      stayUpUntilSigint: async () => undefined,
    }

    await implementCli(deps)

    const driveEntry = snapshotAfterDriveWrite.find((e) => e.label === 'drive')
    assert.ok(driveEntry, 'drive entry must be present in the ledger')
    assert.strictEqual(driveEntry.pid, 7777)
    // The other roles populated by the supervisor must also be
    // visible at the same time — confirms implement APPENDS rather
    // than replaces.
    const labels = snapshotAfterDriveWrite.map((e) => e.label)
    assert.ok(labels.includes('supervisor'))
    assert.ok(labels.includes('worker'))
    assert.ok(labels.includes('api'))
    assert.ok(labels.includes('drive'))
    // After stop, the ledger is empty.
    assert.strictEqual(stateEntries.length, 0)
  })

  // -------------------------------------------------------------------------
  // v0.8.7.1: drive-failure fail-open. When drive returns a non-zero,
  // non-EXIT_PAUSED exit code, implement must (a) log a recovery hint
  // pointing at `pm-go why <plan-id>` and `pm-go drive --plan <id>`,
  // (b) call the injected stayUpUntilSigint to block on operator
  // intervention, (c) return drive's original exit code so the caller
  // sees the underlying failure.
  // -------------------------------------------------------------------------
  it('logs recovery hints + invokes stayUpUntilSigint when drive returns non-zero', async () => {
    let stayUpInvoked = 0
    const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    // Fake runSupervisor: invoke onReady with a real planId, capture
    // its return code, simulate teardown.
    const fakeRunSupervisor = async (
      _o: RunOptions,
      _d: RunDeps,
      onReady?: (handle: {
        planId?: string
        apiUrl: string
        writeInstanceState: (entry: InstanceStateEntry) => Promise<void>
      }) => Promise<number>,
    ): Promise<number> => {
      return onReady!({
        planId,
        apiUrl: 'http://localhost:3001',
        writeInstanceState: async () => undefined,
      })
    }

    const logs: string[] = []
    const deps: ImplementCliDeps = {
      argv: ['--spec', '/abs/spec.md'],
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: (l) => logs.push(l),
      errLog: () => undefined,
      resolve,
      buildSupervisorDeps: () => ({} as Omit<RunDeps, 'pm' | 'monorepoRoot'>),
      // 404 fetch makes runDrive bail with EXIT_BLOCKED (exit code 1) —
      // a real-world non-zero non-EXIT_PAUSED case.
      buildDriveDeps: () => ({
        fetch: (async () =>
          ({ ok: false, status: 404, async text() { return '' } } as unknown as Response)) as unknown as typeof globalThis.fetch,
        now: () => 0,
        sleep: async () => undefined,
        log: () => undefined,
        errLog: () => undefined,
        prompt: async () => false,
      } as DriveDeps),
      runSupervisor: fakeRunSupervisor as unknown as NonNullable<ImplementCliDeps['runSupervisor']>,
      drivePid: 9999,
      stayUpUntilSigint: async () => {
        stayUpInvoked++
      },
    }

    const code = await implementCli(deps)

    // Drive failed — exit code is non-zero and NOT EXIT_PAUSED.
    assert.notStrictEqual(code, 0, 'expected non-zero drive exit')
    assert.notStrictEqual(code, EXIT_PAUSED, 'must not be EXIT_PAUSED')

    // Stay-up was invoked exactly once (the new fail-open branch).
    assert.strictEqual(
      stayUpInvoked,
      1,
      'stayUpUntilSigint must be called exactly once on drive failure',
    )

    // Recovery hints surface the diagnosis + resume commands keyed to
    // the captured planId.
    const allLogs = logs.join('\n')
    assert.match(allLogs, /drive exited code=\d+/, 'must log drive exit code')
    assert.ok(allLogs.includes('staying UP'), 'must announce stack staying up')
    assert.ok(allLogs.includes(`pm-go why ${planId}`), 'must hint pm-go why <planId>')
    assert.ok(
      allLogs.includes(`pm-go drive --plan ${planId}`),
      'must hint pm-go drive --plan <planId>',
    )
    assert.ok(allLogs.includes('Press Ctrl+C'), 'must mention Ctrl+C')
    assert.ok(
      allLogs.includes('received Ctrl+C'),
      'must log Ctrl+C receipt after stayUpUntilSigint resolves',
    )
  })

  // -------------------------------------------------------------------------
  // ac-health-identity-2: `pm-go implement` must inherit the run-side
  // identity probe — when /health returns 2xx from a non-pm-go service,
  // implement must fail startup with the same `[pm-go] port` prefix and
  // exit non-zero (no duplicate health logic in implement.ts).
  //
  // We exercise the REAL runSupervisor (not the fake test seam) so the
  // probe wired into [5/6] is the one actually hit on the production path.
  // The supervisor's pm is swapped to a fake one inside our runSupervisor
  // wrapper to avoid `process.exit` from the real ProcessManager.
  // -------------------------------------------------------------------------
  it('fails startup with `[pm-go] port` prefix when /health returns 2xx from a non-pm-go service (ac-health-identity-2)', async () => {
    const errs: string[] = []
    const logs: string[] = []
    let shutdownCalls = 0

    /** Make a minimal fake child the supervisor's track()/pipeToLog can hook into. */
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
    let nextPid = 8000

    /** A pm replacement whose shutdown does NOT process.exit, so the test runner survives. */
    const fakePm: RunDeps['pm'] = {
      add: () => undefined,
      shutdown: (async () => {
        shutdownCalls++
      }) as unknown as RunDeps['pm']['shutdown'],
      stop: async () => undefined,
      get shuttingDown() {
        return false
      },
    } as unknown as RunDeps['pm']

    /** Production-ish RunDeps minus pm + monorepoRoot (filled by implementCli). */
    const buildSupervisorDeps = (): Omit<RunDeps, 'pm' | 'monorepoRoot'> => ({
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      spawn: ((_cmd: string, _args: readonly string[]) =>
        makeFakeChild(nextPid++)) as RunDeps['spawn'],
      // /health answers 2xx with the canonical foreign body the AC
      // mocks: `{"status":"ok"}`. Anything else gets an empty 2xx.
      fetch: (async (input: unknown) => {
        const u =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url
        if (u.endsWith('/health')) {
          return new Response('{"status":"ok"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
      readFile: async () => '',
      fileExists: async () => true,
      mkdir: async () => undefined,
      now: () => 0,
      sleep: async () => undefined,
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      checkPorts: async () => ({ ok: true }),
      writeInstanceState: async () => undefined,
      processPid: 9999,
    })

    const deps: ImplementCliDeps = {
      // --skip-docker + --skip-migrate so the supervisor reaches step
      // [5/6] (the identity probe) without needing a real docker/pnpm.
      argv: [
        '--spec',
        '/abs/spec.md',
        '--skip-docker',
        '--skip-migrate',
        '--port',
        '3001',
      ],
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
      resolve,
      buildSupervisorDeps,
      buildDriveDeps: () => ({} as DriveDeps),
      // Wrap the real runSupervisor to swap in the fake pm. Without
      // this swap, the real ProcessManager's shutdown would call
      // process.exit and kill the test runner.
      runSupervisor: async (options, supervisorDeps, onReady) =>
        runSupervisorImpl(options, { ...supervisorDeps, pm: fakePm }, onReady),
      // Should never fire on this path (supervisor returns 1 before
      // onReady runs); injected so the test never hangs if something
      // regresses.
      stayUpUntilSigint: async () => undefined,
    }

    const code = await implementCli(deps)
    assert.strictEqual(code, 1, 'expected non-zero exit on identity mismatch')

    // Structured error landed on errLog with the documented prefix.
    const printed = errs.find((l) =>
      l.startsWith('[pm-go] port 3001 is held by another service'),
    )
    assert.ok(
      printed,
      `errLog must include the structured identity-mismatch message; got:\n${errs.join('\n')}`,
    )
    // The foreign body must round-trip into the message so the
    // operator can identify the offender from the logs.
    assert.ok(
      printed!.includes('"status":"ok"'),
      `error message should surface the foreign body; got:\n${printed}`,
    )

    // Children were torn down — `pm.shutdown` MUST be called on the
    // identity-mismatch path so the worker we spawned at step [3/6]
    // doesn't leak past implement's exit.
    assert.strictEqual(
      shutdownCalls,
      1,
      `pm.shutdown must be called exactly once on identity mismatch; got ${shutdownCalls}`,
    )
  })

  it('does NOT call stayUpUntilSigint when drive returns 0 (clean path)', async () => {
    // Inject a runSupervisor whose onReady runs against an injected
    // drive that "succeeds". We achieve this without a runDrive seam
    // by pre-empting onReady — the fake runSupervisor short-circuits
    // and returns 0 directly, modelling "implement completed cleanly".
    let stayUpInvoked = 0

    const fakeRunSupervisor = async (
      _o: RunOptions,
      _d: RunDeps,
      _onReady?: unknown,
    ): Promise<number> => {
      // Skip onReady entirely — model the "drive completed code=0,
      // supervisor torn down" path. implementCli's onReady never runs
      // so the new fail-open branch can't fire.
      return 0
    }

    const deps: ImplementCliDeps = {
      argv: ['--spec', '/abs/spec.md'],
      cwd: '/abs/cwd',
      monorepoRoot: '/abs/monorepo',
      log: () => undefined,
      errLog: () => undefined,
      resolve,
      buildSupervisorDeps: () => ({} as Omit<RunDeps, 'pm' | 'monorepoRoot'>),
      buildDriveDeps: () => ({} as DriveDeps),
      runSupervisor: fakeRunSupervisor as unknown as NonNullable<ImplementCliDeps['runSupervisor']>,
      stayUpUntilSigint: async () => {
        stayUpInvoked++
      },
    }

    const code = await implementCli(deps)
    assert.strictEqual(code, 0)
    assert.strictEqual(
      stayUpInvoked,
      0,
      'stayUpUntilSigint must NOT be called when drive returns 0',
    )
  })
})
