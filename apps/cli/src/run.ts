/**
 * `pm-go run` — single-command supervisor.
 *
 * Replaces the "open three terminals + run six commands" workflow
 * with one foreground process that:
 *
 *   1. Verifies the local Docker / Postgres / Temporal stack is up
 *      (and brings it up via `docker compose up -d` if not).
 *   2. Applies pending DB migrations.
 *   3. Spawns the worker and the API as tracked child processes,
 *      waiting on each `/health` endpoint to confirm readiness.
 *   4. Optionally submits a feature spec via `POST /spec-documents`
 *      and starts a plan via `POST /plans`.
 *   5. Stays attached, prints next-step hints, and forwards SIGINT
 *      to the children so `Ctrl+C` cleanly tears everything down.
 *
 * Pure argv parsing + plan-emission lives in this file; effectful
 * I/O lives behind the `RunDeps` interface so the orchestration can
 * be unit-tested without spawning real processes.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'

import { applyDotenv, type ApplyDotenvResult } from './lib/dotenv.js'
import {
  createProcessManager,
  track,
  type ProcessManager,
} from './lib/process-manager.js'
import { httpReady, waitFor } from './lib/wait-for.js'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface RunOptions {
  /** Absolute path to the target repository. */
  repoRoot: string
  /** Absolute path to the spec markdown file (optional). */
  specPath: string | undefined
  /** Title for the spec document. Falls back to first H1 or filename. */
  title: string | undefined
  /** Runtime mode for every agent role. */
  runtime: 'auto' | 'stub' | 'sdk' | 'claude'
  /** Override the default API port (3001). */
  apiPort: number
  /** Override DATABASE_URL when stack is already running externally. */
  databaseUrl: string
  /** Skip `docker compose up` even if the stack appears down. */
  skipDocker: boolean
  /** Skip `pnpm db:migrate` (e.g. CI already migrated). */
  skipMigrate: boolean
}

/**
 * Handle passed to a `RunOptions.onReady` callback. Lets the caller
 * use the supervisor as a library: kick off a downstream flow (e.g.
 * `pm-go drive`) once the stack is up, then return an exit code that
 * the supervisor uses as its own. `pm-go implement` is the primary
 * caller — it submits a spec via the supervisor, then drives the
 * resulting plan to release.
 */
export interface SupervisorReadyHandle {
  /** UUID of the plan started by --spec, when one was submitted. */
  planId?: string
  /** API base URL (e.g. http://localhost:3001). */
  apiUrl: string
  /**
   * Append a child entry to the per-instance state file. Reused by
   * `pm-go implement` to record the in-process drive worker (label
   * `'drive'`) under the same registry the supervisor populated for
   * worker + api + the supervisor itself. Pruning happens inside
   * `process-manager`'s shutdown path so the file vanishes atomically
   * with the children.
   */
  writeInstanceState: (entry: InstanceStateEntry) => Promise<void>
}

/**
 * Roles tracked by the per-instance state file. The supervisor writes
 * `supervisor`/`worker`/`api`; `pm-go implement` extends with `drive`.
 * Anything else is a programming bug — keep this enum tight so a typo
 * shows up at the type level rather than landing as garbage on disk.
 */
export type InstanceStateLabel = 'supervisor' | 'worker' | 'api' | 'drive'

export interface InstanceStateEntry {
  /** Role of the process this entry represents. */
  label: InstanceStateLabel
  /** OS PID of the process. */
  pid: number
}

/**
 * Per-port conflict report produced by `RunDeps.checkPorts`. `owner`
 * distinguishes "this is OUR worker/api still hanging around from a
 * crashed prior run" (in which case `pm-go recover` is the answer)
 * from "another process owns this" (in which case we MUST refuse to
 * start, because we'd otherwise stomp on a user's local stack).
 */
export interface PortConflict {
  port: number
  pid: number | null
  owner: 'pm-go' | 'unknown'
}

export type PortPreflightResult =
  | { ok: true }
  | { ok: false; conflicts: PortConflict[] }

/**
 * Multiline remediation string emitted when port pre-flight detects a
 * non-pm-go process holding one of the ports we need. Exported so the
 * tests can assert exact equality against it — keeps the wording
 * pinned to the same string operators will paste into a bug report.
 */
export function formatPortConflictError(conflicts: readonly PortConflict[]): string {
  const lines = conflicts
    .filter((c) => c.owner !== 'pm-go')
    .map(
      (c) =>
        `  - port ${c.port} is held by pid ${c.pid ?? 'unknown'} (not owned by pm-go)`,
    )
  return [
    '[pm-go] port preflight failed: cannot start because the following ports are in use:',
    ...lines,
    '[pm-go] Stop the conflicting process(es) or rerun with --port <n> for the API,',
    '[pm-go] then retry. (Run `pm-go ps` to inspect any pm-go-owned processes.)',
  ].join('\n')
}

export interface ParsedArgv {
  ok: true
  options: RunOptions
}

export interface ArgvError {
  ok: false
  error: string
}

const DEFAULT_DATABASE_URL = 'postgres://pmgo:pmgo@localhost:5432/pm_go'
const DEFAULT_API_PORT = 3001

/**
 * Parse `pm-go run` argv into a typed RunOptions, resolving relative
 * paths against `cwd`. Returns a tagged union so callers can render
 * a friendly error without throwing.
 */
export function parseRunArgv(
  argv: readonly string[],
  cwd: string,
  resolve: (a: string, b: string) => string,
): ParsedArgv | ArgvError {
  const opts: Partial<RunOptions> = {
    runtime: 'auto',
    apiPort: DEFAULT_APR_PORT_FALLBACK(),
    // Honour DATABASE_URL from the environment (.env or shell) before
    // falling back to the dev-stack default. CLI flag still wins.
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    skipDocker: false,
    skipMigrate: false,
    specPath: undefined,
    title: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--repo':
      case '-r':
        if (!value) return { ok: false, error: `${flag} requires a path` }
        opts.repoRoot = resolve(cwd, value)
        i++
        break
      case '--spec':
      case '-s':
        if (!value) return { ok: false, error: `${flag} requires a path` }
        opts.specPath = resolve(cwd, value)
        i++
        break
      case '--title':
        if (!value) return { ok: false, error: `${flag} requires a value` }
        opts.title = value
        i++
        break
      case '--runtime': {
        if (!value) return { ok: false, error: `${flag} requires a value` }
        const allowed = ['auto', 'stub', 'sdk', 'claude'] as const
        if (!allowed.includes(value as (typeof allowed)[number])) {
          return {
            ok: false,
            error: `${flag} must be one of ${allowed.join(', ')}`,
          }
        }
        opts.runtime = value as RunOptions['runtime']
        i++
        break
      }
      case '--port':
      case '-p': {
        if (!value) return { ok: false, error: `${flag} requires a number` }
        const port = Number.parseInt(value, 10)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return { ok: false, error: `${flag} must be an integer 1..65535` }
        }
        opts.apiPort = port
        i++
        break
      }
      case '--database-url':
        if (!value) return { ok: false, error: `${flag} requires a value` }
        opts.databaseUrl = value
        i++
        break
      case '--skip-docker':
        opts.skipDocker = true
        break
      case '--skip-migrate':
        opts.skipMigrate = true
        break
      case '--help':
      case '-h':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }

  if (!opts.repoRoot) {
    // Default to the cwd — same convention as `npm install` etc.
    opts.repoRoot = cwd
  }

  return { ok: true, options: opts as RunOptions }
}

/**
 * Default API port lookup. Honors `API_PORT` from the environment
 * (which may have been populated from `.env` by the time argv parses)
 * and falls back to 3001 otherwise. Indirected so callers can see
 * the precedence order in one place.
 */
function DEFAULT_APR_PORT_FALLBACK(): number {
  const fromEnv = process.env.API_PORT
  if (fromEnv) {
    const n = Number.parseInt(fromEnv, 10)
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  }
  return DEFAULT_API_PORT
}

/**
 * Describe the auth source the worker will use, in priority order
 * matching `hasSdkAccess()` in apps/worker:
 *
 *   1. ANTHROPIC_API_KEY env var → SDK
 *   2. ~/.claude/.credentials.json present → SDK (Claude Code OAuth)
 *   3. claude CLI on PATH → CLI runner
 *   4. otherwise → none (will throw on first activity)
 *
 * `--runtime stub` short-circuits to "stub" since the worker won't
 * call any auth-dependent factory.
 *
 * Pure on `process.env`/fs — no network. Async because OAuth
 * detection needs `fileExists`.
 */
async function describeAuthSource(
  deps: { fileExists: (p: string) => Promise<boolean> },
  runtime: RunOptions['runtime'],
): Promise<string> {
  if (runtime === 'stub') return 'stub mode (no Claude calls)'
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY (env)'
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) {
    const oauth = `${home}/.claude/.credentials.json`
    if (await deps.fileExists(oauth)) {
      return 'Claude Code OAuth (~/.claude/.credentials.json)'
    }
  }
  // We can't easily detect `claude --version` here (would shell out
  // and slow boot); the worker will fall back to CLI / fail loudly.
  return 'none detected — worker will fail unless --runtime stub'
}

// ---------------------------------------------------------------------------
// Side-effect deps (injected for tests)
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface SpawnHandle {
  proc: ChildProcess
}

export interface RunDeps {
  /** One-shot subprocess (resolves on exit). */
  exec: (
    cmd: string,
    args: readonly string[],
    opts?: SpawnOptions,
  ) => Promise<ExecResult>
  /** Long-running subprocess. Caller wraps in track(). */
  spawn: (
    cmd: string,
    args: readonly string[],
    opts?: SpawnOptions,
  ) => ChildProcess
  /** HTTP fetch (defaults to globalThis.fetch). */
  fetch: typeof globalThis.fetch
  /** Filesystem reads — only `readFile` for spec body. */
  readFile: (path: string) => Promise<string>
  fileExists: (path: string) => Promise<boolean>
  mkdir: (path: string, opts: { recursive?: boolean }) => Promise<void>
  /** Wall-clock + sleep so waitFor can be mocked. */
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Output sinks. */
  log: (line: string) => void
  errLog: (line: string) => void
  /** Process-group manager (SIGINT/SIGTERM forwarding). */
  pm: ProcessManager
  /** Repo root the supervisor itself was launched from (where pnpm runs). */
  monorepoRoot: string
  /**
   * Pre-flight: check whether the supervisor's required host ports
   * (postgres 5432, temporal 7233, temporal-ui 8233, api `apiPort`)
   * are free. Called BEFORE `docker compose up` so a colliding local
   * stack (the canonical x402all-on-5432 footgun) is rejected loudly
   * instead of silently destabilizing Docker.
   */
  checkPorts: (ports: readonly number[]) => Promise<PortPreflightResult>
  /**
   * Append an entry to the per-instance state file written under
   * `~/.pm-go/instances/<name>/state.json`. The supervisor records its
   * own pid and the worker + api child pids; `pm-go implement` adds a
   * `drive` entry. Removed atomically by the process-manager during
   * shutdown / stop so a stale file never points at a dead pid.
   */
  writeInstanceState: (entry: InstanceStateEntry) => Promise<void>
  /** Supervisor's own pid — injected so tests can pin it deterministically. */
  processPid: number
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const POSTGRES_TIMEOUT_MS = 60_000
const TEMPORAL_TIMEOUT_MS = 60_000
const API_HEALTH_TIMEOUT_MS = 30_000
const PLAN_PERSISTENCE_TIMEOUT_MS = 20 * 60_000
const POLL_INTERVAL_MS = 500

/**
 * Supervisor entry-point. Returns the parent process exit code:
 *   - 0 when every step succeeded and the user explicitly stopped (SIGINT).
 *   - 1 when a step failed (the failure is logged before return).
 *
 * When `onReady` is provided (e.g. by `pm-go implement`), the
 * supervisor invokes the callback after the stack is up and returns
 * the callback's exit code instead of blocking on children. The
 * supervisor still calls `pm.stop()` to tear down children gracefully
 * before returning.
 */
export async function runSupervisor(
  options: RunOptions,
  deps: RunDeps,
  onReady?: (handle: SupervisorReadyHandle) => Promise<number>,
): Promise<number> {
  const { log, errLog } = deps

  // Resolve which auth source the worker would pick up, mirroring
  // `hasSdkAccess()` in apps/worker so the banner is honest. Async
  // because we need to fileExists the OAuth credentials path.
  const authSource = await describeAuthSource(deps, options.runtime)

  log('')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('  pm-go run')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log(`  repo:    ${options.repoRoot}`)
  log(`  runtime: ${options.runtime}`)
  log(`  auth:    ${authSource}`)
  log(`  api:     http://localhost:${options.apiPort}`)
  if (options.specPath) log(`  spec:    ${options.specPath}`)
  log('')

  // 0. Sanity: pm-go monorepo + target repo exist.
  if (!(await deps.fileExists(`${deps.monorepoRoot}/pnpm-workspace.yaml`))) {
    errLog(
      `pm-go run must be invoked from a pm-go monorepo checkout (looked at ${deps.monorepoRoot}). ` +
        'Slice 1 does not yet support remote checkouts.',
    )
    return 1
  }
  if (!(await deps.fileExists(options.repoRoot))) {
    errLog(`--repo path does not exist: ${options.repoRoot}`)
    return 1
  }
  if (options.specPath && !(await deps.fileExists(options.specPath))) {
    errLog(`--spec file not found: ${options.specPath}`)
    return 1
  }

  // 1. Docker stack.
  if (!options.skipDocker) {
    // Pre-flight host ports BEFORE we run any docker command. The
    // canonical regression we're guarding: a target repo's local
    // stack (e.g. x402all start.sh) already binds host postgres
    // 5432, then `docker compose up` here destabilizes Docker. We'd
    // rather refuse to start with an actionable message than chase a
    // hung Docker daemon afterwards.
    const requiredPorts: readonly number[] = [
      5432,
      7233,
      8233,
      options.apiPort,
    ]
    const preflight = await deps.checkPorts(requiredPorts)
    if (!preflight.ok) {
      const foreign = preflight.conflicts.filter((c) => c.owner !== 'pm-go')
      if (foreign.length > 0) {
        // Print the documented remediation and bail BEFORE touching
        // docker — colliding starts are exactly what we promised the
        // operator we'd avoid.
        errLog(formatPortConflictError(foreign))
        return 1
      }
      // Every conflicting port was held by a pm-go-owned process.
      // That's recoverable territory (`pm-go recover`); log it but
      // continue so the supervisor can adopt the existing stack.
      log(
        `[pm-go] port preflight: ${preflight.conflicts.length} pm-go-owned port(s) already bound — continuing.`,
      )
    }

    log('[1/6] starting Docker stack (postgres + temporal)...')
    const dockerCheck = await deps.exec('docker', ['ps', '--format', '{{.Names}}'], {
      cwd: deps.monorepoRoot,
    })
    if (dockerCheck.code !== 0) {
      errLog(
        'docker daemon not reachable. Start Docker Desktop, or pass --skip-docker if running Postgres/Temporal externally.',
      )
      return 1
    }
    // Run `docker compose up -d` unconditionally. It's idempotent —
    // already-running services are a no-op — and it self-heals partial
    // stacks (e.g. Postgres up but Temporal stopped) which the prior
    // "only-if-postgres-container-not-found" guard silently missed.
    const up = await deps.exec('docker', ['compose', 'up', '-d'], {
      cwd: deps.monorepoRoot,
    })
    if (up.code !== 0) {
      errLog(`docker compose up failed:\n${up.stderr}`)
      return 1
    }
    log('       waiting for postgres...')
    // Use `docker compose exec` so the probe targets the service by
    // its compose-file name (`postgres`), not by a container name
    // that depends on the project / directory name. A user who
    // cloned into `~/projects/my-pm-go` would otherwise get a
    // container called `my-pm-go-postgres-1` and the old probe would
    // time out forever.
    const pgReady = await waitFor(
      async () => {
        const r = await deps.exec(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            'postgres',
            'pg_isready',
            '-U',
            'pmgo',
            '-d',
            'pm_go',
          ],
          { cwd: deps.monorepoRoot },
        )
        return r.code === 0
      },
      { label: 'postgres', timeoutMs: POSTGRES_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      deps,
    )
    if (pgReady.status === 'timeout') {
      errLog(`postgres not ready after ${POSTGRES_TIMEOUT_MS}ms (${pgReady.lastError ?? 'no error captured'})`)
      return 1
    }
    log('       waiting for temporal...')
    const temporalReady = await waitFor(
      async () => {
        const r = await deps.exec(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            'temporal',
            'tctl',
            '--ad',
            'localhost:7233',
            'cluster',
            'health',
          ],
          { cwd: deps.monorepoRoot },
        )
        return r.code === 0
      },
      { label: 'temporal', timeoutMs: TEMPORAL_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
      deps,
    )
    if (temporalReady.status === 'timeout') {
      // Temporal CLI shape varies between image versions (tctl vs
      // `temporal operator cluster health`); fall through with a
      // warning instead of failing the supervisor outright. The
      // worker's own connect attempt will surface a hard failure if
      // the cluster really isn't reachable.
      log('       (temporal health probe inconclusive; continuing — worker will hard-fail if unreachable)')
    }
  } else {
    log('[1/6] --skip-docker: assuming postgres + temporal are already up')
  }

  // 2. Migrations.
  if (!options.skipMigrate) {
    log('[2/6] applying database migrations...')
    const migrate = await deps.exec('pnpm', ['db:migrate'], {
      cwd: deps.monorepoRoot,
      env: { ...process.env, DATABASE_URL: options.databaseUrl },
    })
    if (migrate.code !== 0) {
      errLog(`pnpm db:migrate failed:\n${migrate.stderr || migrate.stdout}`)
      return 1
    }
  } else {
    log('[2/6] --skip-migrate: not applying migrations')
  }

  // 3. Worker.
  // Spawn `node` directly against the compiled dist so SIGTERM lands
  // on the worker PID, not on a pnpm wrapper process. Requires the
  // worker package to have been built — checked just below.
  log('[3/6] starting worker...')
  const workerEntry = `${deps.monorepoRoot}/apps/worker/dist/index.js`
  const apiEntry = `${deps.monorepoRoot}/apps/api/dist/index.js`
  for (const [label, entry] of [
    ['worker', workerEntry],
    ['api', apiEntry],
  ] as const) {
    if (!(await deps.fileExists(entry))) {
      errLog(
        `${label} dist not found at ${entry}. Run \`pnpm -r build\` once before \`pm-go run\`.`,
      )
      return 1
    }
  }
  const workerEnv = buildChildEnv(options)
  const workerProc = deps.spawn(process.execPath, [workerEntry], {
    cwd: `${deps.monorepoRoot}/apps/worker`,
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const worker = track('worker', workerProc)
  pipeToLog(worker.proc, deps.log, 'worker')
  deps.pm.add(worker)

  // 4. API.
  log('[4/6] starting api...')
  const apiProc = deps.spawn(process.execPath, [apiEntry], {
    cwd: `${deps.monorepoRoot}/apps/api`,
    env: workerEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const api = track('api', apiProc)
  pipeToLog(api.proc, deps.log, 'api')
  deps.pm.add(api)

  // 5. Wait for API health.
  log(`[5/6] waiting for api on http://localhost:${options.apiPort}/health...`)
  const apiReady = await waitFor(
    httpReady(deps.fetch, `http://localhost:${options.apiPort}/health`),
    { label: 'api', timeoutMs: API_HEALTH_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
    deps,
  )
  if (apiReady.status === 'timeout') {
    errLog(`api /health did not respond after ${API_HEALTH_TIMEOUT_MS}ms`)
    await deps.pm.shutdown('startup failure', 1).catch(() => undefined)
    return 1
  }

  // Persist the per-instance process registry now that the API is
  // confirmed live. We deliberately wait until AFTER httpReady so
  // partial-startup crashes don't leave a half-populated state file
  // around for `pm-go ps` to misreport. Order: supervisor first
  // (guaranteed pid), then worker, then api. The process-manager will
  // remove the file atomically during stop/shutdown.
  await deps.writeInstanceState({ label: 'supervisor', pid: deps.processPid })
  if (typeof worker.proc.pid === 'number') {
    await deps.writeInstanceState({ label: 'worker', pid: worker.proc.pid })
  }
  if (typeof api.proc.pid === 'number') {
    await deps.writeInstanceState({ label: 'api', pid: api.proc.pid })
  }

  // 6. Optional: submit spec + start plan.
  let planId: string | undefined
  if (options.specPath) {
    log('[6/6] submitting spec + starting plan...')
    try {
      planId = await submitSpecAndPlan(options, deps)
      log(`       plan started: ${planId}`)
    } catch (err) {
      errLog(
        `spec submission failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      // Don't bring down the supervisor — the user can submit a different
      // spec via the API or TUI without restarting the stack.
    }
  } else {
    log('[6/6] no --spec provided; skipping plan submission')
  }

  printAttachHint(options, planId, deps.log)

  // When a caller (`pm-go implement`) wants to use the supervisor as
  // a library — boot the stack, run something against it, tear it
  // down — they pass `onReady`. We invoke it with the planId/apiUrl,
  // then `pm.stop()` (graceful, no process.exit) so the caller can
  // return whatever exit code makes sense.
  if (onReady) {
    const apiUrl = `http://localhost:${options.apiPort}`
    let exitCode = 0
    try {
      exitCode = await onReady({
        ...(planId !== undefined ? { planId } : {}),
        apiUrl,
        // Forward writeInstanceState so callers (`pm-go implement`)
        // can extend the same registry the supervisor populated above
        // — e.g. with a `drive` entry for the in-process drive worker.
        writeInstanceState: deps.writeInstanceState,
      })
    } catch (err) {
      errLog(
        `[pm-go] onReady callback threw: ${err instanceof Error ? err.message : String(err)}`,
      )
      exitCode = 1
    }
    await deps.pm.stop('onReady completed').catch(() => undefined)
    return exitCode
  }

  // Block until a child crashes or a signal terminates us.
  const exits = [worker.exit, api.exit].map((p, idx) =>
    p.then((r) => ({ idx, ...r })),
  )
  const crashed = await Promise.race(exits)
  if (!deps.pm.shuttingDown) {
    const labels = ['worker', 'api']
    errLog(
      `${labels[crashed.idx]} exited with code=${crashed.code} signal=${crashed.signal} — tearing down`,
    )
    await deps.pm.shutdown('child crashed', 1).catch(() => undefined)
    return 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Every per-role *_RUNTIME env var the worker inspects. Centralised
 *  so add/remove of a role only touches one constant. */
const RUNTIME_ENV_KEYS = [
  'PLANNER_RUNTIME',
  'IMPLEMENTER_RUNTIME',
  'REVIEWER_RUNTIME',
  'PHASE_AUDITOR_RUNTIME',
  'COMPLETION_AUDITOR_RUNTIME',
] as const

/**
 * Legacy *_EXECUTOR_MODE env vars the worker also inspects when
 * *_RUNTIME is unset. Carried for backward compatibility with
 * pre-v0.8 deployments. The worker treats `live` as "use Claude SDK"
 * and anything else (or unset) as "stub", so a stale
 * `*_EXECUTOR_MODE=live` left in `.env` from a prior dogfood run
 * would silently launch live runners despite `--runtime stub`.
 */
const EXECUTOR_MODE_ENV_KEYS = [
  'PLANNER_EXECUTOR_MODE',
  'IMPLEMENTER_EXECUTOR_MODE',
  'REVIEWER_EXECUTOR_MODE',
  'PHASE_AUDITOR_EXECUTOR_MODE',
  'COMPLETION_AUDITOR_EXECUTOR_MODE',
] as const

/**
 * Build the env vars passed to the worker + API child processes.
 * Translates `--runtime` into the canonical `*_RUNTIME` env vars for
 * every agent role.
 *
 * Precedence:
 *   - For `--runtime sdk|claude|auto`: explicit shell-exported
 *     `*_RUNTIME=...` wins (advanced users mixing roles); otherwise
 *     the flag fans out to every role.
 *   - For `--runtime stub`: the explicit flag ALWAYS wins. BOTH
 *     inherited `*_RUNTIME=...` AND legacy `*_EXECUTOR_MODE=live`
 *     are deleted from the child env. A stale .env from a prior
 *     dogfood run cannot silently turn an onboarding/CI smoke into
 *     a live run that fails when `ANTHROPIC_API_KEY` is missing.
 */
export function buildChildEnv(opts: RunOptions): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: opts.databaseUrl,
    API_PORT: String(opts.apiPort),
    REPO_ROOT: opts.repoRoot,
  }
  if (opts.runtime === 'stub') {
    for (const key of RUNTIME_ENV_KEYS) {
      delete base[key]
    }
    for (const key of EXECUTOR_MODE_ENV_KEYS) {
      delete base[key]
    }
    return base
  }
  const role = opts.runtime
  for (const key of RUNTIME_ENV_KEYS) {
    base[key] = base[key] ?? role
  }
  return base
}

function pipeToLog(
  proc: ChildProcess,
  log: (line: string) => void,
  label: string,
): void {
  const onChunk = (buf: Buffer) => {
    for (const line of buf.toString('utf8').split('\n')) {
      if (line.length > 0) log(`[${label}] ${line}`)
    }
  }
  proc.stdout?.on('data', onChunk)
  proc.stderr?.on('data', onChunk)
}

async function submitSpecAndPlan(
  opts: RunOptions,
  deps: RunDeps,
): Promise<string> {
  if (!opts.specPath) throw new Error('specPath required')
  const body = await deps.readFile(opts.specPath)
  const title = opts.title ?? deriveTitle(body, opts.specPath)

  const apiBase = `http://localhost:${opts.apiPort}`
  const specRes = await deps.fetch(`${apiBase}/spec-documents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      repoRoot: opts.repoRoot,
      source: 'manual',
    }),
  })
  if (!specRes.ok) {
    const text = await specRes.text().catch(() => '')
    throw new Error(`POST /spec-documents → ${specRes.status}: ${text}`)
  }
  const specJson = (await specRes.json()) as {
    specDocumentId: string
    repoSnapshotId: string
  }

  const planRes = await deps.fetch(`${apiBase}/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      specDocumentId: specJson.specDocumentId,
      repoSnapshotId: specJson.repoSnapshotId,
      requestedBy: 'pm-go-cli',
    }),
  })
  if (!planRes.ok) {
    const text = await planRes.text().catch(() => '')
    throw new Error(`POST /plans → ${planRes.status}: ${text}`)
  }
  const planJson = (await planRes.json()) as { planId: string }

  // POST /plans returns 202 — the SpecToPlanWorkflow is async and the
  // plan row only lands in Postgres after the planner finishes. Poll
  // GET /plans/:id until it returns 200 (or timeout) so callers like
  // `pm-go drive` and `pm-go implement` can immediately operate on
  // the plan without racing the workflow. Live Opus planning on large
  // specs can run for several minutes, so keep this comfortably above
  // the startup-scale timeouts.
  const planQueryable = await waitFor(
    async () => {
      const res = await deps.fetch(`${apiBase}/plans/${planJson.planId}`)
      return res.ok
    },
    {
      label: 'plan-persistence',
      timeoutMs: PLAN_PERSISTENCE_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
    },
    deps,
  )
  if (planQueryable.status === 'timeout') {
    throw new Error(
      `plan ${planJson.planId} did not appear in the API within ${PLAN_PERSISTENCE_TIMEOUT_MS / 1000}s — the SpecToPlanWorkflow may have failed; check worker logs`,
    )
  }
  return planJson.planId
}

/**
 * Pull a title from the first `# Heading` line of the spec body, or
 * fall back to the filename (without extension) if no heading exists.
 */
export function deriveTitle(body: string, path: string): string {
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*#\s+(.+)$/)
    if (match && match[1]) return match[1].trim()
  }
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? 'spec'
  return name.replace(/\.[^.]+$/, '')
}

function printAttachHint(
  opts: RunOptions,
  planId: string | undefined,
  log: (line: string) => void,
): void {
  log('')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('  pm-go is running')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log(`  api:     http://localhost:${opts.apiPort}`)
  log(`  health:  curl http://localhost:${opts.apiPort}/health`)
  if (planId) {
    log(`  plan:    curl http://localhost:${opts.apiPort}/plans/${planId} | jq`)
    log(`  events:  curl -N -H 'accept: text/event-stream' \\`)
    log(`             http://localhost:${opts.apiPort}/events?planId=${planId}`)
  } else {
    log(`  plans:   curl http://localhost:${opts.apiPort}/plans | jq`)
  }
  log('  attach:  pnpm tui          # in another terminal')
  log('  stop:    Ctrl+C            # cleanly tears everything down')
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  log('')
}

// ---------------------------------------------------------------------------
// Public entry-point — wires the production deps and dispatches.
// ---------------------------------------------------------------------------

export const RUN_USAGE = `Usage: pm-go run [options]

Boots the local pm-go control plane in one foreground process: starts
the Docker stack (postgres + temporal), applies migrations, launches
the worker and API as tracked children, optionally submits a feature
spec to start a plan, and forwards Ctrl+C cleanly to all children.

Options:
  --repo, -r <path>         Target repository root (default: cwd).
  --spec, -s <path>         Spec markdown to submit + start a plan for.
  --title <string>          Title for the spec doc (default: first H1 in body).
  --runtime <mode>          auto | stub | sdk | claude (default: auto).
  --port, -p <n>            API port (default: 3001).
  --database-url <url>      Override DATABASE_URL.
  --skip-docker             Skip docker compose; assume stack is up.
  --skip-migrate            Skip pnpm db:migrate.
  --help, -h                Show this message.

Examples:
  pm-go run                                         # boot the stack only
  pm-go run --spec ./examples/golden-path/spec.md   # boot + submit spec
  pm-go run --runtime stub --skip-docker            # CI / smokes
`

export interface RunCliDeps {
  argv: readonly string[]
  cwd: string
  monorepoRoot: string
  log: (line: string) => void
  errLog: (line: string) => void
  /** Build the production deps used by runSupervisor. */
  buildSupervisorDeps: (pm: ProcessManager) => Omit<RunDeps, 'pm' | 'monorepoRoot'>
  /** Path resolution helper (defaults to node:path resolve). */
  resolve: (a: string, b: string) => string
  /**
   * Optional .env loader. When present, the dispatcher calls it
   * exactly once with `<monorepoRoot>/.env` before argv parsing so
   * env-driven defaults (DATABASE_URL, API_PORT, ANTHROPIC_API_KEY)
   * are visible to subsequent steps. Tests omit this to keep the
   * orchestration deterministic.
   */
  applyDotenv?: (path: string) => Promise<ApplyDotenvResult>
  /**
   * Atomic remover for the per-instance state file. Threaded into the
   * process-manager so SIGINT / SIGTERM (or a successful `pm.stop`)
   * deletes the state file in the same step that kills the children.
   * Pairs with `RunDeps.writeInstanceState`; both come from the same
   * filesystem-backed implementation in `index.ts`.
   */
  removeInstanceState?: () => Promise<void>
}

/**
 * CLI dispatcher for `pm-go run`. Loads .env first (so env-driven
 * defaults are visible to argv parsing), parses argv, prints usage
 * on `--help`, builds the supervisor deps, and runs the orchestration.
 * Returns the exit code; the index.ts wrapper calls `process.exit`.
 *
 * Precedence (highest to lowest):
 *   1. Explicit `pm-go run` CLI flag
 *   2. Already-exported shell env var
 *   3. monorepoRoot/.env value
 *   4. Hardcoded default
 *
 * `.env` is genuinely optional — if the file is absent we just skip
 * loading (no warning), matching the dotenv convention.
 */
export async function runCli(cliDeps: RunCliDeps): Promise<number> {
  // Load .env BEFORE argv parsing so DATABASE_URL / API_PORT defaults
  // can pick up values placed in the file. Pre-existing shell exports
  // are preserved (we only fill in unset keys).
  let dotenvResult: ApplyDotenvResult | undefined
  if (cliDeps.applyDotenv) {
    dotenvResult = await cliDeps.applyDotenv(`${cliDeps.monorepoRoot}/.env`)
  }

  const parsed = parseRunArgv(cliDeps.argv, cliDeps.cwd, cliDeps.resolve)
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      cliDeps.log(RUN_USAGE)
      return 0
    }
    cliDeps.errLog(`pm-go run: ${parsed.error}`)
    cliDeps.errLog('')
    cliDeps.errLog(RUN_USAGE)
    return 2
  }

  // Surface a single line about .env loading after argv parsing so
  // `--help` output stays clean. We log COUNTS, never values, to
  // keep the supervisor's startup banner safe to paste in bug reports.
  if (dotenvResult?.loaded) {
    cliDeps.log(
      `[pm-go] loaded .env (${dotenvResult.applied.length} applied, ${dotenvResult.skipped.length} pre-set in shell)`,
    )
    for (const w of dotenvResult.warnings) {
      cliDeps.errLog(`[pm-go] .env: ${w}`)
    }
  }

  const pm = createProcessManager({
    process,
    log: (l) => cliDeps.errLog(l),
    // Wire the same removeInstanceState the buildSupervisorDeps half
    // of the cliDeps uses for write — keeps the create/remove pair
    // pointing at the same canonical state file.
    ...(cliDeps.removeInstanceState
      ? { removeInstanceState: cliDeps.removeInstanceState }
      : {}),
  })
  const supervisorDeps: RunDeps = {
    ...cliDeps.buildSupervisorDeps(pm),
    pm,
    monorepoRoot: cliDeps.monorepoRoot,
  }
  return runSupervisor(parsed.options, supervisorDeps)
}
