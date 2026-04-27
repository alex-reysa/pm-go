import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runDoctor,
  resolveAutoRuntime,
  buildDoctorReport,
  probeInfrastructure,
  applyRepairs,
  formatInfraProbes,
  INFRA_PROBE_NAMES,
  type InfraProbe,
  type InfraProbeDeps,
  type RepairDeps,
} from '../doctor.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal DetectedRuntime stub (no @pm-go/runtime-detector import needed). */
function makeRuntime(cliCommand: string, version = '1.0.0') {
  return { adapter: { cliCommand }, version }
}

/** Capture runDoctor output into an array and return { lines, output, exitCode }. */
async function capture(
  opts: {
    env?: Record<string, string | undefined>
    runtimes?: ReturnType<typeof makeRuntime>[]
  } = {},
) {
  const lines: string[] = []
  const exitCode = await runDoctor({
    detectRuntimes: async () => opts.runtimes ?? [],
    env: opts.env ?? {},
    write: (l) => lines.push(l),
  })
  return { lines, output: lines.join('\n'), exitCode }
}

// ---------------------------------------------------------------------------
// ac-dc-03 — three --runtime auto resolution scenarios
// ---------------------------------------------------------------------------

describe('resolveAutoRuntime', () => {
  it('(a) SDK key set, no CLIs → anthropic-sdk', () => {
    const result = resolveAutoRuntime({ ANTHROPIC_API_KEY: 'sk-ant-test' }, [])
    assert.strictEqual(result.kind, 'anthropic-sdk')
    assert.ok(result.reason.includes('ANTHROPIC_API_KEY'))
  })

  it('(b) no SDK key, claude CLI on PATH → claude-cli', () => {
    const result = resolveAutoRuntime({}, [makeRuntime('claude', '1.2.3')])
    assert.strictEqual(result.kind, 'claude-cli')
    assert.ok(result.reason.includes('claude'))
  })

  it('(c) both ANTHROPIC_API_KEY and claude CLI available → anthropic-sdk wins', () => {
    const result = resolveAutoRuntime(
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
      [makeRuntime('claude', '1.2.3')],
    )
    assert.strictEqual(result.kind, 'anthropic-sdk')
  })

  it('(d) OAuth session present, no SDK key, no CLI → anthropic-sdk (oauth)', () => {
    const result = resolveAutoRuntime({}, [], { hasOAuth: true })
    assert.strictEqual(result.kind, 'anthropic-sdk')
    assert.ok(result.reason.toLowerCase().includes('oauth'))
  })

  it('(e) OAuth + claude CLI: OAuth wins (SDK preferred over CLI)', () => {
    const result = resolveAutoRuntime(
      {},
      [makeRuntime('claude', '1.2.3')],
      { hasOAuth: true },
    )
    assert.strictEqual(result.kind, 'anthropic-sdk')
  })

  it('(f) OAuth + ANTHROPIC_API_KEY: API key wins (env beats OAuth)', () => {
    const result = resolveAutoRuntime(
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
      [],
      { hasOAuth: true },
    )
    assert.strictEqual(result.kind, 'anthropic-sdk')
    assert.ok(result.reason.includes('ANTHROPIC_API_KEY'))
  })

  it('(g) hasOAuth=false explicit → falls through to CLI/etc', () => {
    const result = resolveAutoRuntime(
      {},
      [makeRuntime('claude', '1.2.3')],
      { hasOAuth: false },
    )
    assert.strictEqual(result.kind, 'claude-cli')
  })
})

// ---------------------------------------------------------------------------
// ac-dc-02 — no runtime available → exits 1 + prints expected message
// ---------------------------------------------------------------------------

describe('runDoctor exit codes', () => {
  it('exits 1 when no API key and no CLI found', async () => {
    const { exitCode, output } = await capture({ env: {}, runtimes: [] })
    assert.strictEqual(exitCode, 1)
    assert.ok(output.includes('no supported runtime available'), `expected 'no supported runtime available' in: ${output}`)
  })

  it('exits 0 when ANTHROPIC_API_KEY is set', async () => {
    const { exitCode } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [],
    })
    assert.strictEqual(exitCode, 0)
  })

  it('exits 0 when claude CLI is available', async () => {
    const { exitCode } = await capture({
      env: {},
      runtimes: [makeRuntime('claude')],
    })
    assert.strictEqual(exitCode, 0)
  })
})

// ---------------------------------------------------------------------------
// ac-dc-03 — assert printed resolution line matches expectations
// ---------------------------------------------------------------------------

describe('runDoctor resolution output line', () => {
  it('(a) SDK only: prints anthropic-sdk resolution', async () => {
    const { output } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [],
    })
    assert.match(output, /--runtime auto\s+→\s+anthropic-sdk/)
    assert.ok(output.includes('ANTHROPIC_API_KEY is set'))
  })

  it('(b) CLI only: prints claude-cli resolution', async () => {
    const { output } = await capture({
      env: {},
      runtimes: [makeRuntime('claude', '1.2.3')],
    })
    assert.match(output, /--runtime auto\s+→\s+claude-cli/)
    assert.ok(output.includes('claude CLI found on PATH'))
  })

  it('(c) both: prints anthropic-sdk (API key takes priority)', async () => {
    const { output } = await capture({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      runtimes: [makeRuntime('claude', '1.2.3')],
    })
    assert.match(output, /--runtime auto\s+→\s+anthropic-sdk/)
    assert.ok(!output.includes('claude-cli'), 'should not mention claude-cli when SDK key wins')
  })
})

// ---------------------------------------------------------------------------
// ac-dc-04 — snapshot-style test for overall output structure / table format
// ---------------------------------------------------------------------------

const EXPECTED_ALL_RUNTIMES = `pm-go doctor
──────────────────────────────────────────

Environment
  ANTHROPIC_API_KEY        ✓ set
  OPENROUTER_API_KEY       ✓ set
  OPENAI_API_KEY           ✓ set

Local CLIs
  claude                   ✓ 1.2.3
  codex                    ✓ 0.1.0
  gemini                   ✓ 2.0.0

Runtime resolution
  --runtime auto           → anthropic-sdk  (ANTHROPIC_API_KEY is set)

Infrastructure
  (no additional checks in v0.8.0)`

const EXPECTED_NO_RUNTIMES = `pm-go doctor
──────────────────────────────────────────

Environment
  ANTHROPIC_API_KEY        not set
  OPENROUTER_API_KEY       not set
  OPENAI_API_KEY           not set

Local CLIs
  claude                   not found
  codex                    not found
  gemini                   not found

Runtime resolution
  --runtime auto           → no supported runtime available

Infrastructure
  (no additional checks in v0.8.0)`

describe('buildDoctorReport snapshot', () => {
  it('matches expected table structure with all runtimes present', () => {
    const runtimes = [
      makeRuntime('claude', '1.2.3'),
      makeRuntime('codex', '0.1.0'),
      makeRuntime('gemini', '2.0.0'),
    ]
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENROUTER_API_KEY: 'or-test',
      OPENAI_API_KEY: 'sk-test',
    }
    const report = buildDoctorReport(env, runtimes)
    assert.strictEqual(report, EXPECTED_ALL_RUNTIMES)
  })

  it('matches expected table structure with no runtimes', () => {
    const report = buildDoctorReport({}, [])
    assert.strictEqual(report, EXPECTED_NO_RUNTIMES)
  })

  it('contains all four required blocks', () => {
    const report = buildDoctorReport({}, [])
    assert.ok(report.includes('Environment'), 'missing Environment block')
    assert.ok(report.includes('Local CLIs'), 'missing Local CLIs block')
    assert.ok(report.includes('Runtime resolution'), 'missing Runtime resolution block')
    assert.ok(report.includes('Infrastructure'), 'missing Infrastructure block')
  })
})

// ---------------------------------------------------------------------------
// Slice 3: probeInfrastructure
// ---------------------------------------------------------------------------

interface ExecCall {
  cmd: string
  args: readonly string[]
}

interface FakeInfraOpts {
  /** Map of `${cmd} ${args.join(' ')}` → exec result. */
  execs?: Record<string, { code: number; stdout?: string; stderr?: string }>
  /** Default exec when no map entry matches (defaults to code 0). */
  defaultExec?: { code: number; stdout?: string; stderr?: string }
  exists?: Record<string, boolean>
  writable?: Record<string, boolean>
  env?: Record<string, string | undefined>
  monorepoRoot?: string
}

function makeInfraDeps(opts: FakeInfraOpts = {}): {
  deps: InfraProbeDeps
  calls: ExecCall[]
} {
  const calls: ExecCall[] = []
  const root = opts.monorepoRoot ?? '/repo'
  const exists = opts.exists ?? {}
  const writable = opts.writable ?? {}
  const execs = opts.execs ?? {}
  const defaultExec = opts.defaultExec ?? { code: 0 }

  const deps: InfraProbeDeps = {
    exec: async (cmd, args) => {
      calls.push({ cmd, args })
      const key = `${cmd} ${args.join(' ')}`
      const r = execs[key] ?? defaultExec
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    env: opts.env ?? {},
    fileExists: async (p) => exists[p] ?? false,
    isWritable: async (p) => writable[p] ?? false,
    monorepoRoot: root,
  }
  return { deps, calls }
}

describe('probeInfrastructure', () => {
  it('reports docker-not-running when `docker ps` fails', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1, stderr: 'Cannot connect to the Docker daemon' },
      },
    })
    const probes = await probeInfrastructure(deps)
    const docker = probes.find((p) => p.name === INFRA_PROBE_NAMES.docker)
    assert.ok(docker)
    assert.strictEqual(docker.status, 'fail')
    assert.match(docker.message ?? '', /docker daemon not running/i)
    assert.strictEqual(docker.repairable, false)
  })

  it('reports docker-CLI-missing when exec throws ENOENT', async () => {
    const calls: ExecCall[] = []
    const deps: InfraProbeDeps = {
      exec: async (cmd, args) => {
        calls.push({ cmd, args })
        if (cmd === 'docker') throw new Error('spawn docker ENOENT')
        return { code: 0, stdout: '', stderr: '' }
      },
      env: {},
      fileExists: async () => false,
      isWritable: async () => false,
      monorepoRoot: '/repo',
    }
    const probes = await probeInfrastructure(deps)
    const docker = probes.find((p) => p.name === INFRA_PROBE_NAMES.docker)!
    assert.strictEqual(docker.status, 'fail')
    assert.match(docker.message ?? '', /docker CLI not found/i)
  })

  it('skips postgres + temporal probes when docker daemon is down', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1, stderr: 'Cannot connect' },
      },
    })
    const probes = await probeInfrastructure(deps)
    const pg = probes.find((p) => p.name === INFRA_PROBE_NAMES.postgresContainer)!
    const tempo = probes.find((p) => p.name === INFRA_PROBE_NAMES.temporalContainer)!
    assert.strictEqual(pg.status, 'fail')
    assert.match(pg.message ?? '', /skipped/i)
    assert.strictEqual(tempo.status, 'fail')
    assert.match(tempo.message ?? '', /skipped/i)
  })

  it('reports postgres ok when pg_isready returns 0', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 0 },
        'docker compose exec -T postgres pg_isready -U pmgo -d pm_go': { code: 0 },
        'docker compose exec -T temporal sh -c tctl --ad "$(hostname -i):7233" cluster health': {
          code: 0,
        },
        'docker compose exec -T postgres psql -U pmgo -d pm_go -c SELECT 1': {
          code: 0,
        },
      },
      env: { DATABASE_URL: 'postgres://x' },
      exists: { '/repo': true, '/repo/.worktrees': true, '/repo/.integration-worktrees': true, '/repo/artifacts': true },
      writable: { '/repo': true, '/repo/.worktrees': true, '/repo/.integration-worktrees': true, '/repo/artifacts': true },
    })
    const probes = await probeInfrastructure(deps)
    const pg = probes.find((p) => p.name === INFRA_PROBE_NAMES.postgresContainer)!
    assert.strictEqual(pg.status, 'ok')
  })

  it('reports postgres fail (repairable) when pg_isready exits non-zero', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 0 },
        'docker compose exec -T postgres pg_isready -U pmgo -d pm_go': {
          code: 2,
          stderr: 'no pg_isready',
        },
      },
    })
    const probes = await probeInfrastructure(deps)
    const pg = probes.find((p) => p.name === INFRA_PROBE_NAMES.postgresContainer)!
    assert.strictEqual(pg.status, 'fail')
    assert.strictEqual(pg.repairable, true)
    assert.match(pg.message ?? '', /pnpm docker:up|pm-go doctor --repair/)
  })

  it('temporal probe tolerates "serving" stdout but warns', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 0 },
        'docker compose exec -T postgres pg_isready -U pmgo -d pm_go': { code: 0 },
        'docker compose exec -T temporal sh -c tctl --ad "$(hostname -i):7233" cluster health': {
          code: 1,
          stdout: 'temporal.api.workflowservice.v1.WorkflowService: SERVING',
        },
      },
    })
    const probes = await probeInfrastructure(deps)
    const tempo = probes.find((p) => p.name === INFRA_PROBE_NAMES.temporalContainer)!
    assert.strictEqual(tempo.status, 'warn')
    assert.match(tempo.message ?? '', /serving/i)
  })

  it('reports DATABASE_URL fail when env var unset', async () => {
    const { deps } = makeInfraDeps({
      execs: { 'docker ps': { code: 1 } },
      env: {},
    })
    const probes = await probeInfrastructure(deps)
    const url = probes.find((p) => p.name === INFRA_PROBE_NAMES.databaseUrl)!
    assert.strictEqual(url.status, 'fail')
    assert.strictEqual(url.repairable, false)
    assert.match(url.message ?? '', /DATABASE_URL not set/)
  })

  it('reports pending migrations when files outnumber journal entries', async () => {
    // 3 sql files, but journal has only 2 → 1 pending.
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1 }, // skip pg/tempo
        'ls /repo/db/migrations': {
          code: 0,
          stdout: '0000_a.sql\n0001_b.sql\n0002_c.sql\nmeta\n',
        },
        'cat /repo/db/migrations/meta/_journal.json': {
          code: 0,
          stdout: JSON.stringify({ entries: [{ tag: '0000_a' }, { tag: '0001_b' }] }),
        },
      },
      exists: {
        '/repo/db/migrations': true,
        '/repo/db/migrations/meta/_journal.json': true,
      },
    })
    const probes = await probeInfrastructure(deps)
    const m = probes.find((p) => p.name === INFRA_PROBE_NAMES.migrations)!
    assert.strictEqual(m.status, 'fail')
    assert.strictEqual(m.repairable, true)
    assert.match(m.message ?? '', /1 pending migration/)
  })

  it('reports migrations OK when files == journal entries', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1 },
        'ls /repo/db/migrations': {
          code: 0,
          stdout: '0000_a.sql\n0001_b.sql\nmeta\n',
        },
        'cat /repo/db/migrations/meta/_journal.json': {
          code: 0,
          stdout: JSON.stringify({ entries: [{ tag: '0000_a' }, { tag: '0001_b' }] }),
        },
      },
      exists: {
        '/repo/db/migrations': true,
        '/repo/db/migrations/meta/_journal.json': true,
      },
    })
    const probes = await probeInfrastructure(deps)
    const m = probes.find((p) => p.name === INFRA_PROBE_NAMES.migrations)!
    assert.strictEqual(m.status, 'ok')
  })

  it('flags missing worktrees dir as repairable', async () => {
    const { deps } = makeInfraDeps({
      execs: { 'docker ps': { code: 1 } },
      exists: { '/repo': true },
      writable: { '/repo': true },
    })
    const probes = await probeInfrastructure(deps)
    const w = probes.find((p) => p.name === INFRA_PROBE_NAMES.worktreesDir)!
    assert.strictEqual(w.status, 'fail')
    assert.strictEqual(w.repairable, true)
    assert.match(w.message ?? '', /does not exist/)
  })

  it('flags non-writable repo path as NOT repairable', async () => {
    const { deps } = makeInfraDeps({
      execs: { 'docker ps': { code: 1 } },
      exists: { '/repo': true },
      writable: { '/repo': false },
    })
    const probes = await probeInfrastructure(deps)
    const r = probes.find((p) => p.name === INFRA_PROBE_NAMES.repoWritable)!
    assert.strictEqual(r.status, 'fail')
    assert.strictEqual(r.repairable, false)
    assert.match(r.message ?? '', /not writable/)
  })

  it('reports API port free when lsof exits non-zero', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1 },
        'lsof -nP -i :3001': { code: 1, stdout: '' },
      },
    })
    const probes = await probeInfrastructure(deps)
    const port = probes.find((p) => p.name === INFRA_PROBE_NAMES.apiPort)!
    assert.strictEqual(port.status, 'ok')
  })

  it('reports API port in use with PID + command', async () => {
    const { deps } = makeInfraDeps({
      execs: {
        'docker ps': { code: 1 },
        'lsof -nP -i :3001': {
          code: 0,
          stdout:
            'COMMAND  PID USER   FD   TYPE\nnode   12345 dev   23u  IPv4\n',
        },
      },
    })
    const probes = await probeInfrastructure(deps)
    const port = probes.find((p) => p.name === INFRA_PROBE_NAMES.apiPort)!
    assert.strictEqual(port.status, 'fail')
    assert.strictEqual(port.repairable, false)
    assert.match(port.message ?? '', /node/)
    assert.match(port.message ?? '', /12345/)
    assert.match(port.message ?? '', /Kill PID/)
  })
})

// ---------------------------------------------------------------------------
// Slice 3: applyRepairs
// ---------------------------------------------------------------------------

function makeRepairDeps(opts: FakeInfraOpts = {}): {
  deps: RepairDeps
  calls: ExecCall[]
  mkdirCalls: string[]
  logs: string[]
} {
  const calls: ExecCall[] = []
  const mkdirCalls: string[] = []
  const logs: string[] = []
  const root = opts.monorepoRoot ?? '/repo'
  const execs = opts.execs ?? {}
  const defaultExec = opts.defaultExec ?? { code: 0 }
  const exists = opts.exists ?? {}
  const writable = opts.writable ?? {}

  const deps: RepairDeps = {
    exec: async (cmd, args) => {
      calls.push({ cmd, args })
      const key = `${cmd} ${args.join(' ')}`
      const r = execs[key] ?? defaultExec
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
    env: opts.env ?? {},
    fileExists: async (p) => exists[p] ?? false,
    isWritable: async (p) => writable[p] ?? false,
    monorepoRoot: root,
    mkdir: async (p) => {
      mkdirCalls.push(p)
    },
    log: (l) => logs.push(l),
  }
  return { deps, calls, mkdirCalls, logs }
}

describe('applyRepairs', () => {
  it('returns nothing when no probes are failing', async () => {
    const { deps } = makeRepairDeps()
    const probes: InfraProbe[] = [
      { name: 'x', status: 'ok' },
    ]
    const out = await applyRepairs(probes, deps)
    assert.deepStrictEqual(out, { repaired: [], failed: [] })
  })

  it('skips non-repairable failures', async () => {
    const { deps, calls } = makeRepairDeps()
    const probes: InfraProbe[] = [
      { name: INFRA_PROBE_NAMES.apiPort, status: 'fail', message: 'in use', repairable: false },
    ]
    const out = await applyRepairs(probes, deps)
    assert.deepStrictEqual(out, { repaired: [], failed: [] })
    assert.strictEqual(calls.length, 0)
  })

  it('creates missing dirs via mkdir(recursive=true)', async () => {
    const { deps, mkdirCalls } = makeRepairDeps()
    const probes: InfraProbe[] = [
      {
        name: INFRA_PROBE_NAMES.worktreesDir,
        status: 'fail',
        message: 'missing',
        repairable: true,
      },
      {
        name: INFRA_PROBE_NAMES.artifactsDir,
        status: 'fail',
        message: 'missing',
        repairable: true,
      },
    ]
    const out = await applyRepairs(probes, deps)
    assert.deepStrictEqual(mkdirCalls.sort(), ['/repo/.worktrees', '/repo/artifacts'].sort())
    assert.ok(out.repaired.includes(INFRA_PROBE_NAMES.worktreesDir))
    assert.ok(out.repaired.includes(INFRA_PROBE_NAMES.artifactsDir))
    assert.strictEqual(out.failed.length, 0)
  })

  it('runs `docker compose up -d` for missing services', async () => {
    const { deps, calls } = makeRepairDeps({
      execs: { 'docker compose up -d': { code: 0 } },
    })
    const probes: InfraProbe[] = [
      {
        name: INFRA_PROBE_NAMES.postgresContainer,
        status: 'fail',
        repairable: true,
      },
    ]
    const out = await applyRepairs(probes, deps)
    assert.ok(calls.some((c) => c.cmd === 'docker' && c.args.join(' ') === 'compose up -d'))
    assert.ok(out.repaired.includes('docker compose up'))
  })

  it('records docker compose up failure', async () => {
    const { deps } = makeRepairDeps({
      execs: { 'docker compose up -d': { code: 1, stderr: 'no permission' } },
    })
    const probes: InfraProbe[] = [
      { name: INFRA_PROBE_NAMES.temporalContainer, status: 'fail', repairable: true },
    ]
    const out = await applyRepairs(probes, deps)
    assert.strictEqual(out.repaired.length, 0)
    assert.strictEqual(out.failed.length, 1)
    assert.match(out.failed[0]!.reason, /no permission/)
  })

  it('runs `pnpm db:migrate` for pending migrations', async () => {
    const { deps, calls } = makeRepairDeps({
      execs: { 'pnpm db:migrate': { code: 0 } },
    })
    const probes: InfraProbe[] = [
      { name: INFRA_PROBE_NAMES.migrations, status: 'fail', repairable: true },
    ]
    const out = await applyRepairs(probes, deps)
    assert.ok(calls.some((c) => c.cmd === 'pnpm' && c.args.join(' ') === 'db:migrate'))
    assert.ok(out.repaired.includes(INFRA_PROBE_NAMES.migrations))
  })

  it('records migration failure', async () => {
    const { deps } = makeRepairDeps({
      execs: { 'pnpm db:migrate': { code: 1, stderr: 'duplicate column' } },
    })
    const probes: InfraProbe[] = [
      { name: INFRA_PROBE_NAMES.migrations, status: 'fail', repairable: true },
    ]
    const out = await applyRepairs(probes, deps)
    assert.strictEqual(out.repaired.length, 0)
    assert.match(out.failed[0]!.reason, /duplicate column/)
  })

  it('is idempotent on a second pass with no failing probes', async () => {
    const { deps } = makeRepairDeps()
    const probes: InfraProbe[] = [{ name: 'x', status: 'ok' }]
    const a = await applyRepairs(probes, deps)
    const b = await applyRepairs(probes, deps)
    assert.deepStrictEqual(a, b)
  })

  it('logs each repair step via deps.log', async () => {
    const { deps, logs } = makeRepairDeps({
      execs: { 'docker compose up -d': { code: 0 } },
    })
    const probes: InfraProbe[] = [
      { name: INFRA_PROBE_NAMES.postgresContainer, status: 'fail', repairable: true },
    ]
    await applyRepairs(probes, deps)
    assert.ok(logs.some((l) => l.includes('docker compose up -d')))
  })
})

// ---------------------------------------------------------------------------
// Slice 3: runDoctor wired with infra deps
// ---------------------------------------------------------------------------

describe('runDoctor with infra deps', () => {
  it('emits real Infrastructure rows when infra deps are wired', async () => {
    const { deps: infra } = makeInfraDeps({
      execs: {
        'docker ps': { code: 0 },
        'docker compose exec -T postgres pg_isready -U pmgo -d pm_go': { code: 0 },
        'docker compose exec -T temporal sh -c tctl --ad "$(hostname -i):7233" cluster health': {
          code: 0,
        },
        'docker compose exec -T postgres psql -U pmgo -d pm_go -c SELECT 1': { code: 0 },
        'lsof -nP -i :3001': { code: 1 },
      },
      env: { DATABASE_URL: 'postgres://x' },
      exists: {
        '/repo': true,
        '/repo/.worktrees': true,
        '/repo/.integration-worktrees': true,
        '/repo/artifacts': true,
      },
      writable: {
        '/repo': true,
        '/repo/.worktrees': true,
        '/repo/.integration-worktrees': true,
        '/repo/artifacts': true,
      },
    })
    const lines: string[] = []
    const code = await runDoctor({
      detectRuntimes: async () => [],
      env: { ANTHROPIC_API_KEY: 'k' },
      write: (l) => lines.push(l),
      infra,
    })
    assert.strictEqual(code, 0)
    const out = lines.join('\n')
    assert.ok(out.includes('Infrastructure'))
    assert.ok(out.includes(INFRA_PROBE_NAMES.docker))
    assert.ok(out.includes('✓ ok'))
    assert.ok(!out.includes('(no additional checks in v0.8.0)'))
  })

  it('exits 1 when infra has a failing probe even if runtime is OK', async () => {
    const { deps: infra } = makeInfraDeps({
      execs: { 'docker ps': { code: 1, stderr: 'Cannot connect' } },
      env: {},
    })
    const lines: string[] = []
    const code = await runDoctor({
      detectRuntimes: async () => [],
      env: { ANTHROPIC_API_KEY: 'k' },
      write: (l) => lines.push(l),
      infra,
    })
    assert.strictEqual(code, 1)
  })

  it('runs probe → repair → re-probe when --repair is set', async () => {
    let pgUp = false
    const calls: ExecCall[] = []
    const exec = async (
      cmd: string,
      args: readonly string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> => {
      calls.push({ cmd, args })
      const key = `${cmd} ${args.join(' ')}`
      if (key === 'docker ps') return { code: 0, stdout: '', stderr: '' }
      if (key === 'docker compose exec -T postgres pg_isready -U pmgo -d pm_go') {
        return pgUp ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (key === 'docker compose up -d') {
        pgUp = true
        return { code: 0, stdout: '', stderr: '' }
      }
      // default: succeed silently
      return { code: 0, stdout: '', stderr: '' }
    }
    const env = { ANTHROPIC_API_KEY: 'k', DATABASE_URL: 'x' }
    const exists: Record<string, boolean> = {
      '/repo': true,
      '/repo/.worktrees': true,
      '/repo/.integration-worktrees': true,
      '/repo/artifacts': true,
    }
    const writable: Record<string, boolean> = { ...exists }
    const sharedDeps: InfraProbeDeps = {
      exec,
      env,
      fileExists: async (p) => exists[p] ?? false,
      isWritable: async (p) => writable[p] ?? false,
      monorepoRoot: '/repo',
    }
    const repairDeps: RepairDeps = {
      ...sharedDeps,
      mkdir: async () => {},
      log: () => {},
    }
    const lines: string[] = []
    const code = await runDoctor({
      detectRuntimes: async () => [],
      env,
      write: (l) => lines.push(l),
      infra: sharedDeps,
      repairDeps,
      repair: true,
    })
    const out = lines.join('\n')
    assert.ok(out.includes('Repair'))
    assert.ok(out.includes('Infrastructure (post-repair)'))
    // Post-repair pass should show postgres OK.
    const postRepairIdx = out.indexOf('Infrastructure (post-repair)')
    const postSection = out.slice(postRepairIdx)
    assert.ok(postSection.includes(`${INFRA_PROBE_NAMES.postgresContainer}`))
    assert.strictEqual(code, 0)
  })
})

// ---------------------------------------------------------------------------
// Slice 3: formatInfraProbes
// ---------------------------------------------------------------------------

describe('formatInfraProbes', () => {
  it('pads names to col 24 and shows ✓ ok / ✗ message', () => {
    const lines = formatInfraProbes([
      { name: 'docker daemon', status: 'ok' },
      { name: 'postgres container', status: 'fail', message: 'not running' },
    ])
    assert.strictEqual(lines.length, 2)
    assert.match(lines[0]!, /docker daemon\s+✓ ok/)
    assert.match(lines[1]!, /postgres container\s+✗ not running/)
  })

  it('emits placeholder for empty probe list', () => {
    const lines = formatInfraProbes([])
    assert.strictEqual(lines.length, 1)
    assert.match(lines[0]!, /no infra probes/)
  })
})
