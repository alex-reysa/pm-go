/**
 * doctor subcommand — probes API keys, local CLIs, runtime resolution,
 * AND infrastructure (docker / postgres / temporal / migrations / writable
 * dirs / API port). Optionally repairs what's auto-fixable when --repair
 * is passed.
 *
 * All I/O is injected via DoctorDeps / InfraProbeDeps / RepairDeps so unit
 * tests can run without real child-process spawning, real env, or real fs.
 */

/** Minimal shape we need from a detected runtime entry. */
interface DetectedRuntime {
  adapter: { cliCommand: string }
  version: string
}

export interface DoctorDeps {
  /** Returns the list of CLIs that are currently available on PATH. */
  detectRuntimes: () => Promise<DetectedRuntime[]>
  /** Environment variable map (defaults to process.env in production). */
  env: Record<string, string | undefined>
  /** Output sink — one call per line (defaults to console.log). */
  write: (line: string) => void
  /** When true, run probeInfrastructure → applyRepairs → probeInfrastructure. */
  repair?: boolean
  /** Print extra diagnostic info (currently used by error messages). */
  verbose?: boolean
  /** Optional infra deps; when omitted, infra block is skipped. */
  infra?: InfraProbeDeps
  /** Optional repair deps; when omitted, --repair is a no-op. */
  repairDeps?: RepairDeps
}

// ---------------------------------------------------------------------------
// Auto-resolution logic
// ---------------------------------------------------------------------------

export type ResolutionKind =
  | 'anthropic-sdk'
  | 'claude-cli'
  | 'openrouter-sdk'
  | 'openai-sdk'
  | 'none'

export interface ResolutionResult {
  kind: ResolutionKind
  reason: string
}

/**
 * Resolve --runtime auto for the default role set.
 *
 * Priority order:
 *   1. ANTHROPIC_API_KEY set → anthropic-sdk
 *   2. claude CLI on PATH    → claude-cli
 *   3. OPENROUTER_API_KEY    → openrouter-sdk
 *   4. OPENAI_API_KEY        → openai-sdk
 *   5. nothing               → none
 */
export function resolveAutoRuntime(
  env: Record<string, string | undefined>,
  runtimes: DetectedRuntime[],
): ResolutionResult {
  if (env['ANTHROPIC_API_KEY']) {
    return { kind: 'anthropic-sdk', reason: 'ANTHROPIC_API_KEY is set' }
  }
  if (runtimes.some((r) => r.adapter.cliCommand === 'claude')) {
    return { kind: 'claude-cli', reason: 'claude CLI found on PATH' }
  }
  if (env['OPENROUTER_API_KEY']) {
    return { kind: 'openrouter-sdk', reason: 'OPENROUTER_API_KEY is set' }
  }
  if (env['OPENAI_API_KEY']) {
    return { kind: 'openai-sdk', reason: 'OPENAI_API_KEY is set' }
  }
  return { kind: 'none', reason: 'no supported runtime available' }
}

// ---------------------------------------------------------------------------
// Output builder (returns string for snapshot testing)
// ---------------------------------------------------------------------------

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'] as const
const CLI_NAMES = ['claude', 'codex', 'gemini'] as const
const DIVIDER = '─'.repeat(42)
const COL = 24 // left-column width for name

/** Build the doctor report string (without trailing newline). */
export function buildDoctorReport(
  env: Record<string, string | undefined>,
  runtimes: DetectedRuntime[],
): string {
  const lines: string[] = []

  // Header
  lines.push('pm-go doctor')
  lines.push(DIVIDER)
  lines.push('')

  // Environment block
  lines.push('Environment')
  for (const key of ENV_KEYS) {
    const marker = env[key] ? '✓ set' : 'not set'
    lines.push(`  ${key.padEnd(COL)} ${marker}`)
  }
  lines.push('')

  // Local CLIs block
  lines.push('Local CLIs')
  const runtimeMap = new Map(runtimes.map((r) => [r.adapter.cliCommand, r.version]))
  for (const cli of CLI_NAMES) {
    const version = runtimeMap.get(cli)
    const marker = version !== undefined ? `✓ ${version}` : 'not found'
    lines.push(`  ${cli.padEnd(COL)} ${marker}`)
  }
  lines.push('')

  // Runtime resolution block
  const resolution = resolveAutoRuntime(env, runtimes)
  lines.push('Runtime resolution')
  if (resolution.kind === 'none') {
    lines.push(`  --runtime auto           → ${resolution.reason}`)
  } else {
    lines.push(`  --runtime auto           → ${resolution.kind}  (${resolution.reason})`)
  }
  lines.push('')

  // Infrastructure block
  lines.push('Infrastructure')
  lines.push('  (no additional checks in v0.8.0)')

  return lines.join('\n')
}

/** Format an InfraProbe[] into the lines used by the Infrastructure block. */
export function formatInfraProbes(probes: InfraProbe[]): string[] {
  if (probes.length === 0) {
    return ['  (no infra probes available)']
  }
  return probes.map((p) => {
    const name = p.name.padEnd(COL)
    if (p.status === 'ok') {
      return `  ${name} ✓ ok`
    }
    if (p.status === 'warn') {
      return `  ${name} ⚠ ${p.message ?? 'warning'}`
    }
    return `  ${name} ✗ ${p.message ?? 'failed'}`
  })
}

// ---------------------------------------------------------------------------
// Infrastructure probes
// ---------------------------------------------------------------------------

export interface InfraProbe {
  name: string
  status: 'ok' | 'fail' | 'warn'
  message?: string
  /** True when this check could be fixed by --repair. */
  repairable?: boolean
}

export interface InfraProbeDeps {
  exec: (cmd: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  env: Record<string, string | undefined>
  fileExists: (path: string) => Promise<boolean>
  isWritable: (path: string) => Promise<boolean>
  monorepoRoot: string
}

/** Names of every infra probe — kept stable so tests + repair stage can match. */
export const INFRA_PROBE_NAMES = {
  docker: 'docker daemon',
  postgresContainer: 'postgres container',
  temporalContainer: 'temporal container',
  databaseUrl: 'DATABASE_URL',
  databaseReachable: 'database reachable',
  migrations: 'pending migrations',
  repoWritable: 'repo path writable',
  worktreesDir: '.worktrees writable',
  integrationWorktreesDir: '.integration-worktrees writable',
  artifactsDir: 'artifacts/ writable',
  apiPort: 'API port 3001 free',
} as const

/** Probe a single infrastructure dependency. Order is important — the
 *  postgres / temporal probes assume docker daemon is up.
 */
export async function probeInfrastructure(deps: InfraProbeDeps): Promise<InfraProbe[]> {
  const probes: InfraProbe[] = []

  // 1. Docker daemon reachable
  const dockerProbe = await probeDockerDaemon(deps)
  probes.push(dockerProbe)
  const dockerOk = dockerProbe.status === 'ok'

  // 2. Postgres container
  if (dockerOk) {
    probes.push(await probePostgresContainer(deps))
  } else {
    probes.push({
      name: INFRA_PROBE_NAMES.postgresContainer,
      status: 'fail',
      message: 'skipped: docker daemon unreachable',
      repairable: false,
    })
  }

  // 3. Temporal container
  if (dockerOk) {
    probes.push(await probeTemporalContainer(deps))
  } else {
    probes.push({
      name: INFRA_PROBE_NAMES.temporalContainer,
      status: 'fail',
      message: 'skipped: docker daemon unreachable',
      repairable: false,
    })
  }

  // 4. DATABASE_URL set
  probes.push(probeDatabaseUrl(deps))

  // 5. Database reachable (psql SELECT 1) — only if postgres container OK
  const postgresOk = probes.find((p) => p.name === INFRA_PROBE_NAMES.postgresContainer)?.status === 'ok'
  if (postgresOk) {
    probes.push(await probeDatabaseReachable(deps))
  } else {
    probes.push({
      name: INFRA_PROBE_NAMES.databaseReachable,
      status: 'fail',
      message: 'skipped: postgres container not running',
      repairable: true,
    })
  }

  // 6. Pending migrations
  probes.push(await probePendingMigrations(deps))

  // 7. Repo path writable
  probes.push(await probeWritable(deps, deps.monorepoRoot, INFRA_PROBE_NAMES.repoWritable, false))

  // 8. .worktrees writable
  probes.push(
    await probeWritable(
      deps,
      joinPath(deps.monorepoRoot, '.worktrees'),
      INFRA_PROBE_NAMES.worktreesDir,
      true,
    ),
  )

  // 9. .integration-worktrees writable
  probes.push(
    await probeWritable(
      deps,
      joinPath(deps.monorepoRoot, '.integration-worktrees'),
      INFRA_PROBE_NAMES.integrationWorktreesDir,
      true,
    ),
  )

  // 10. artifacts/ writable
  probes.push(
    await probeWritable(
      deps,
      joinPath(deps.monorepoRoot, 'artifacts'),
      INFRA_PROBE_NAMES.artifactsDir,
      true,
    ),
  )

  // 11. API port 3001 free
  probes.push(await probeApiPort(deps))

  return probes
}

async function probeDockerDaemon(deps: InfraProbeDeps): Promise<InfraProbe> {
  try {
    const r = await deps.exec('docker', ['ps'])
    if (r.code === 0) {
      return { name: INFRA_PROBE_NAMES.docker, status: 'ok' }
    }
    const stderr = (r.stderr || r.stdout || '').trim()
    return {
      name: INFRA_PROBE_NAMES.docker,
      status: 'fail',
      message: stderr.includes('Cannot connect')
        ? 'docker daemon not running. Start Docker Desktop.'
        : `docker ps exited ${r.code}. Start Docker Desktop.`,
      repairable: false,
    }
  } catch (err) {
    return {
      name: INFRA_PROBE_NAMES.docker,
      status: 'fail',
      message: `docker CLI not found (${errMsg(err)}). Install Docker Desktop.`,
      repairable: false,
    }
  }
}

async function probePostgresContainer(deps: InfraProbeDeps): Promise<InfraProbe> {
  try {
    const r = await deps.exec('docker', [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_isready',
      '-U',
      'pmgo',
      '-d',
      'pm_go',
    ])
    if (r.code === 0) {
      return { name: INFRA_PROBE_NAMES.postgresContainer, status: 'ok' }
    }
    return {
      name: INFRA_PROBE_NAMES.postgresContainer,
      status: 'fail',
      message:
        'postgres container not running. Run `pnpm docker:up` or `pm-go doctor --repair`.',
      repairable: true,
    }
  } catch (err) {
    return {
      name: INFRA_PROBE_NAMES.postgresContainer,
      status: 'fail',
      message: `postgres probe failed: ${errMsg(err)}. Run \`pm-go doctor --repair\`.`,
      repairable: true,
    }
  }
}

async function probeTemporalContainer(deps: InfraProbeDeps): Promise<InfraProbe> {
  try {
    const r = await deps.exec('docker', [
      'compose',
      'exec',
      '-T',
      'temporal',
      'tctl',
      '--ad',
      'localhost:7233',
      'cluster',
      'health',
    ])
    if (r.code === 0) {
      return { name: INFRA_PROBE_NAMES.temporalContainer, status: 'ok' }
    }
    // Tolerate inconclusive — tctl sometimes exits non-zero on warm-up.
    const out = `${r.stdout}\n${r.stderr}`.toLowerCase()
    if (out.includes('serving') || out.includes('healthy')) {
      return {
        name: INFRA_PROBE_NAMES.temporalContainer,
        status: 'warn',
        message: 'tctl reported serving but exited non-zero',
      }
    }
    return {
      name: INFRA_PROBE_NAMES.temporalContainer,
      status: 'fail',
      message:
        'temporal container not running. Run `pnpm docker:up` or `pm-go doctor --repair`.',
      repairable: true,
    }
  } catch (err) {
    return {
      name: INFRA_PROBE_NAMES.temporalContainer,
      status: 'fail',
      message: `temporal probe failed: ${errMsg(err)}. Run \`pm-go doctor --repair\`.`,
      repairable: true,
    }
  }
}

function probeDatabaseUrl(deps: InfraProbeDeps): InfraProbe {
  if (deps.env['DATABASE_URL']) {
    return { name: INFRA_PROBE_NAMES.databaseUrl, status: 'ok' }
  }
  return {
    name: INFRA_PROBE_NAMES.databaseUrl,
    status: 'fail',
    message:
      'DATABASE_URL not set. Add it to .env (e.g. postgres://pmgo:pmgo@localhost:5432/pm_go).',
    repairable: false,
  }
}

async function probeDatabaseReachable(deps: InfraProbeDeps): Promise<InfraProbe> {
  try {
    const r = await deps.exec('docker', [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'pmgo',
      '-d',
      'pm_go',
      '-c',
      'SELECT 1',
    ])
    if (r.code === 0) {
      return { name: INFRA_PROBE_NAMES.databaseReachable, status: 'ok' }
    }
    return {
      name: INFRA_PROBE_NAMES.databaseReachable,
      status: 'fail',
      message: `psql SELECT 1 failed (exit ${r.code}). Check postgres logs with \`docker compose logs postgres\`.`,
      repairable: false,
    }
  } catch (err) {
    return {
      name: INFRA_PROBE_NAMES.databaseReachable,
      status: 'fail',
      message: `database probe failed: ${errMsg(err)}.`,
      repairable: false,
    }
  }
}

async function probePendingMigrations(deps: InfraProbeDeps): Promise<InfraProbe> {
  // Strategy: count *.sql files in db/migrations vs entries in
  // db/migrations/meta/_journal.json. Mismatch ⇒ pending migrations.
  // The probe is purely filesystem-side, NOT comparing to the live DB.
  const migrationsDir = joinPath(deps.monorepoRoot, 'db', 'migrations')
  const journalPath = joinPath(migrationsDir, 'meta', '_journal.json')

  if (!(await deps.fileExists(migrationsDir))) {
    return {
      name: INFRA_PROBE_NAMES.migrations,
      status: 'warn',
      message: 'db/migrations directory not found.',
    }
  }

  // Discover migration files via shell — `ls`/`find` is overkill since we
  // can lean on `node`'s readdir via a tiny helper we expose through deps.
  // To stay consistent with the InfraProbeDeps shape (no readdir), we
  // shell out to `ls` for simplicity. This stays mockable via deps.exec.
  let files: string[] = []
  try {
    const r = await deps.exec('ls', [migrationsDir])
    if (r.code === 0) {
      files = r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^\d+_.+\.sql$/.test(s))
    }
  } catch {
    // fall through with empty file list
  }

  let journalEntries = 0
  if (await deps.fileExists(journalPath)) {
    try {
      const r = await deps.exec('cat', [journalPath])
      if (r.code === 0) {
        const parsed = JSON.parse(r.stdout) as { entries?: { tag: string }[] }
        journalEntries = parsed.entries?.length ?? 0
      }
    } catch {
      // leave journalEntries = 0
    }
  }

  if (files.length === 0 && journalEntries === 0) {
    return {
      name: INFRA_PROBE_NAMES.migrations,
      status: 'warn',
      message: 'no migrations or journal found.',
    }
  }

  if (files.length > journalEntries) {
    const pending = files.length - journalEntries
    return {
      name: INFRA_PROBE_NAMES.migrations,
      status: 'fail',
      message: `${pending} pending migration${pending === 1 ? '' : 's'}. Run \`pnpm db:migrate\` or \`pm-go doctor --repair\`.`,
      repairable: true,
    }
  }

  return { name: INFRA_PROBE_NAMES.migrations, status: 'ok' }
}

async function probeWritable(
  deps: InfraProbeDeps,
  path: string,
  name: string,
  repairable: boolean,
): Promise<InfraProbe> {
  const exists = await deps.fileExists(path)
  if (!exists) {
    return {
      name,
      status: 'fail',
      message: repairable
        ? `${path} does not exist. Run \`pm-go doctor --repair\` to create it.`
        : `${path} does not exist.`,
      repairable,
    }
  }
  if (await deps.isWritable(path)) {
    return { name, status: 'ok' }
  }
  return {
    name,
    status: 'fail',
    message: `${path} is not writable. Check permissions (chmod u+w).`,
    repairable: false,
  }
}

async function probeApiPort(deps: InfraProbeDeps): Promise<InfraProbe> {
  try {
    // -nP -i :3001 prints binding processes; exit 1 == nothing bound.
    const r = await deps.exec('lsof', ['-nP', '-i', ':3001'])
    if (r.code !== 0 || r.stdout.trim() === '') {
      return { name: INFRA_PROBE_NAMES.apiPort, status: 'ok' }
    }
    // Parse the first non-header line; columns: COMMAND PID USER ...
    const lines = r.stdout.split('\n').filter((l) => l.trim() !== '')
    const dataLines = lines.slice(1) // drop the header
    if (dataLines.length === 0) {
      return { name: INFRA_PROBE_NAMES.apiPort, status: 'ok' }
    }
    const first = dataLines[0]!.split(/\s+/)
    const command = first[0] ?? 'unknown'
    const pid = first[1] ?? '?'
    return {
      name: INFRA_PROBE_NAMES.apiPort,
      status: 'fail',
      message: `port 3001 in use by ${command} (PID ${pid}). Kill PID ${pid} first or stop the conflicting service.`,
      repairable: false,
    }
  } catch (err) {
    // lsof missing is not a fatal infra problem — treat as warn.
    return {
      name: INFRA_PROBE_NAMES.apiPort,
      status: 'warn',
      message: `could not check port 3001 (${errMsg(err)}).`,
    }
  }
}

// ---------------------------------------------------------------------------
// Repair stage
// ---------------------------------------------------------------------------

export interface RepairDeps extends InfraProbeDeps {
  exec: InfraProbeDeps['exec']
  mkdir: (path: string, opts: { recursive?: boolean }) => Promise<void>
  log: (line: string) => void
}

export interface RepairOutcome {
  repaired: string[]
  failed: { name: string; reason: string }[]
}

/**
 * Inspect the failing probes and attempt repair.
 *
 * Repairs are idempotent — running twice in a row produces the same
 * result. Probes flagged `repairable: false` are skipped entirely.
 */
export async function applyRepairs(
  probes: InfraProbe[],
  deps: RepairDeps,
): Promise<RepairOutcome> {
  const repaired: string[] = []
  const failed: { name: string; reason: string }[] = []

  // Bucket the failing probes for batched repairs.
  const failing = probes.filter((p) => p.status === 'fail' && p.repairable === true)
  if (failing.length === 0) {
    return { repaired, failed }
  }

  const needsDockerUp = failing.some(
    (p) =>
      p.name === INFRA_PROBE_NAMES.postgresContainer ||
      p.name === INFRA_PROBE_NAMES.temporalContainer ||
      p.name === INFRA_PROBE_NAMES.databaseReachable,
  )
  const needsMigrations = failing.some((p) => p.name === INFRA_PROBE_NAMES.migrations)
  const dirsToCreate = failing
    .filter(
      (p) =>
        p.name === INFRA_PROBE_NAMES.worktreesDir ||
        p.name === INFRA_PROBE_NAMES.integrationWorktreesDir ||
        p.name === INFRA_PROBE_NAMES.artifactsDir,
    )
    .map((p) => ({
      name: p.name,
      path: dirPathFor(p.name, deps.monorepoRoot),
    }))

  // 1. Create missing dirs.
  for (const { name, path } of dirsToCreate) {
    if (path === null) continue
    deps.log(`[repair] creating ${path}`)
    try {
      await deps.mkdir(path, { recursive: true })
      repaired.push(name)
    } catch (err) {
      failed.push({ name, reason: `mkdir failed: ${errMsg(err)}` })
    }
  }

  // 2. docker compose up -d if any service is missing.
  if (needsDockerUp) {
    deps.log('[repair] running `docker compose up -d`')
    try {
      const r = await deps.exec('docker', ['compose', 'up', '-d'])
      if (r.code === 0) {
        repaired.push('docker compose up')
      } else {
        const reason = (r.stderr || r.stdout || `exit ${r.code}`).trim()
        failed.push({ name: 'docker compose up', reason })
      }
    } catch (err) {
      failed.push({ name: 'docker compose up', reason: errMsg(err) })
    }
  }

  // 3. Apply pending migrations.
  if (needsMigrations) {
    deps.log('[repair] running `pnpm db:migrate`')
    try {
      const r = await deps.exec('pnpm', ['db:migrate'])
      if (r.code === 0) {
        repaired.push(INFRA_PROBE_NAMES.migrations)
      } else {
        const reason = (r.stderr || r.stdout || `exit ${r.code}`).trim()
        failed.push({ name: INFRA_PROBE_NAMES.migrations, reason })
      }
    } catch (err) {
      failed.push({ name: INFRA_PROBE_NAMES.migrations, reason: errMsg(err) })
    }
  }

  return { repaired, failed }
}

function dirPathFor(probeName: string, monorepoRoot: string): string | null {
  if (probeName === INFRA_PROBE_NAMES.worktreesDir) {
    return joinPath(monorepoRoot, '.worktrees')
  }
  if (probeName === INFRA_PROBE_NAMES.integrationWorktreesDir) {
    return joinPath(monorepoRoot, '.integration-worktrees')
  }
  if (probeName === INFRA_PROBE_NAMES.artifactsDir) {
    return joinPath(monorepoRoot, 'artifacts')
  }
  return null
}

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

/**
 * Run the doctor subcommand.
 *
 * Returns exit code:
 *   - 0 when at least one supported runtime is available AND, if infra
 *     probes ran, every probe is `ok` (or `warn`).
 *   - 1 when the runtime is missing, or any infra probe is `fail`.
 *
 * When `repair` is true and `repairDeps` is provided, the doctor runs:
 *   probeInfrastructure → applyRepairs → probeInfrastructure
 *   and reports both passes.
 */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const runtimes = await deps.detectRuntimes()
  const baseReport = buildDoctorReport(deps.env, runtimes)
  // Strip the placeholder Infrastructure block — we'll re-emit it below
  // with real probes when infra deps are available, otherwise leave it.
  const baseLines = baseReport.split('\n')
  const infraIdx = baseLines.lastIndexOf('Infrastructure')
  const head = infraIdx === -1 ? baseLines : baseLines.slice(0, infraIdx)
  for (const line of head) {
    deps.write(line)
  }

  let infraProbes: InfraProbe[] | null = null
  if (deps.infra) {
    infraProbes = await probeInfrastructure(deps.infra)
    deps.write('Infrastructure')
    for (const line of formatInfraProbes(infraProbes)) {
      deps.write(line)
    }
  } else {
    // Preserve the legacy placeholder when no infra deps were wired in.
    deps.write('Infrastructure')
    deps.write('  (no additional checks in v0.8.0)')
  }

  // Repair stage
  if (deps.repair && deps.repairDeps && infraProbes) {
    deps.write('')
    deps.write('Repair')
    const outcome = await applyRepairs(infraProbes, deps.repairDeps)
    if (outcome.repaired.length === 0 && outcome.failed.length === 0) {
      deps.write('  (nothing to repair)')
    } else {
      for (const name of outcome.repaired) {
        deps.write(`  ✓ ${name}`)
      }
      for (const f of outcome.failed) {
        deps.write(`  ✗ ${f.name}: ${f.reason}`)
      }
    }
    // Re-probe and report the new state.
    deps.write('')
    deps.write('Infrastructure (post-repair)')
    infraProbes = await probeInfrastructure(deps.repairDeps)
    for (const line of formatInfraProbes(infraProbes)) {
      deps.write(line)
    }
  }

  const resolution = resolveAutoRuntime(deps.env, runtimes)
  const runtimeOk = resolution.kind !== 'none'
  const infraOk =
    infraProbes === null || infraProbes.every((p) => p.status !== 'fail')
  return runtimeOk && infraOk ? 0 : 1
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => {
      if (i === 0) return p.replace(/\/+$/, '')
      return p.replace(/^\/+/, '').replace(/\/+$/, '')
    })
    .filter((p) => p.length > 0)
    .join('/')
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
