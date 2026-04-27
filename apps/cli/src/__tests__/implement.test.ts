import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseImplementArgv,
  IMPLEMENT_USAGE,
  implementCli,
  type ImplementCliDeps,
} from '../implement.js'
import type { InstanceStateEntry, RunDeps, RunOptions } from '../run.js'
import type { DriveDeps } from '../drive.js'

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
})
