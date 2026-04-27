/**
 * `pm-go implement` — combine `run` + `drive` into one foreground command.
 *
 * Replaces the (already short) two-step workflow:
 *
 *     pnpm pm-go run --spec ./feature.md          (terminal A)
 *     pnpm pm-go drive --plan <uuid>              (terminal B, after copying the plan id)
 *
 * with the single command an end user actually wants to type:
 *
 *     pnpm pm-go implement --repo . --spec ./feature.md
 *
 * Internally:
 *   1. Reuse `runSupervisor` from `./run.js` to bring the stack up,
 *      apply migrations, start the worker + API, and submit the spec
 *      (capturing the resulting planId via the `onReady` callback).
 *   2. Once the supervisor is ready, invoke `runDrive` from `./drive.js`
 *      against the captured planId to drive run/review/fix/integrate/
 *      audit/complete/release in order.
 *   3. Whatever exit code drive returns becomes implement's exit code
 *      and the supervisor tears down its children gracefully.
 *
 * This file is a thin orchestrator — the heavy lifting lives in
 * `run.ts` and `drive.ts`. All side effects flow through deps that
 * the index.ts dispatcher wires up.
 */

import {
  runSupervisor as runSupervisorImpl,
  type RunOptions,
  type RunDeps,
} from './run.js'
import {
  runDrive,
  EXIT_PAUSED,
  type DriveOptions,
  type DriveDeps,
} from './drive.js'
import {
  createProcessManager,
  type ProcessManager,
} from './lib/process-manager.js'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface ImplementOptions {
  /** Absolute path to the target repository. */
  repoRoot: string
  /** Absolute path to the spec markdown file. REQUIRED for implement. */
  specPath: string
  /** Title for the spec document. */
  title: string | undefined
  /** Runtime mode for every agent role. */
  runtime: 'auto' | 'stub' | 'sdk' | 'claude'
  /** API port. */
  apiPort: number
  /** DATABASE_URL override. */
  databaseUrl: string
  /** Skip docker compose up. */
  skipDocker: boolean
  /** Skip db:migrate. */
  skipMigrate: boolean
  /** Approval policy passed straight to runDrive. */
  approve: 'all' | 'none' | 'interactive'
}

export interface ParsedImplementArgv {
  ok: true
  options: ImplementOptions
}

export interface ImplementArgvError {
  ok: false
  error: string
}

const DEFAULT_DATABASE_URL = 'postgres://pmgo:pmgo@localhost:5432/pm_go'
const DEFAULT_API_PORT = 3001

/**
 * Parse `pm-go implement` argv. Same shape as `pm-go run` plus an
 * `--approve` flag forwarded to drive. `--spec` is REQUIRED for
 * implement (the whole point is to drive a freshly-submitted spec
 * end-to-end).
 */
export function parseImplementArgv(
  argv: readonly string[],
  cwd: string,
  resolve: (a: string, b: string) => string,
): ParsedImplementArgv | ImplementArgvError {
  const opts: Partial<ImplementOptions> = {
    runtime: 'auto',
    apiPort: process.env.API_PORT
      ? clampPort(Number.parseInt(process.env.API_PORT, 10))
      : DEFAULT_API_PORT,
    databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    skipDocker: false,
    skipMigrate: false,
    title: undefined,
    approve: 'all',
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
        opts.runtime = value as ImplementOptions['runtime']
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
      case '--approve': {
        if (!value) return { ok: false, error: `${flag} requires a value` }
        const allowed = ['all', 'none', 'interactive'] as const
        if (!allowed.includes(value as (typeof allowed)[number])) {
          return {
            ok: false,
            error: `${flag} must be one of ${allowed.join(', ')}`,
          }
        }
        opts.approve = value as ImplementOptions['approve']
        i++
        break
      }
      case '--help':
      case '-h':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }

  if (!opts.specPath) {
    return {
      ok: false,
      error: '--spec <path> is required for `pm-go implement`',
    }
  }
  if (!opts.repoRoot) {
    opts.repoRoot = cwd
  }

  return { ok: true, options: opts as ImplementOptions }
}

function clampPort(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_API_PORT
  return n
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

export const IMPLEMENT_USAGE = `Usage: pm-go implement --repo <path> --spec <path> [options]

Boot the local pm-go control plane, submit a spec, and drive the resulting
plan to release in one foreground process. Combines \`pm-go run\` and
\`pm-go drive\` so users get the simplest possible UX:

    pm-go implement --repo . --spec ./feature.md

Options:
  --repo, -r <path>      Target repository root (default: cwd).
  --spec, -s <path>      Spec markdown to submit + drive. REQUIRED.
  --title <string>       Title for the spec doc (default: first H1 in body).
  --runtime <mode>       auto | stub | sdk | claude (default: auto).
  --port, -p <n>         API port (default: 3001 or $API_PORT).
  --database-url <url>   Override DATABASE_URL.
  --skip-docker          Skip docker compose; assume stack is up.
  --skip-migrate         Skip pnpm db:migrate.
  --approve <mode>       all | none | interactive (default: all).
  --help, -h             Show this message.

Examples:
  pm-go implement --repo . --spec ./feature.md
  pm-go implement --runtime stub --approve all --spec ./examples/golden-path/spec.md
  pm-go implement --runtime sdk --approve interactive --spec ./feature.md
`

export interface ImplementCliDeps {
  argv: readonly string[]
  cwd: string
  monorepoRoot: string
  log: (line: string) => void
  errLog: (line: string) => void
  resolve: (a: string, b: string) => string
  /** Production deps for the supervisor (excluding pm + monorepoRoot). */
  buildSupervisorDeps: (pm: ProcessManager) => Omit<RunDeps, 'pm' | 'monorepoRoot'>
  /** Production deps for drive. */
  buildDriveDeps: () => DriveDeps
  /** Optional dotenv loader, mirrors run.ts. */
  applyDotenv?: (path: string) => Promise<{ loaded: boolean; applied: string[]; skipped: string[]; warnings: string[] }>
  /**
   * Atomic remover for the per-instance state file (mirrors run.ts).
   * Threaded into the process-manager so the supervisor's teardown
   * also clears the `drive` entry implement appended.
   */
  removeInstanceState?: () => Promise<void>
  /**
   * Test seam: replace the production runSupervisor with a fake.
   * Defaults to the real implementation when omitted. Lets unit tests
   * drive implementCli's onReady path without spinning up Docker /
   * the API / the worker.
   */
  runSupervisor?: typeof runSupervisorImpl
  /**
   * Test seam: pid recorded in the `drive` state entry. Defaults to
   * `process.pid` when omitted. Pinning it lets tests assert exact
   * entries instead of `pid: matchesNumber()`.
   */
  drivePid?: number
  /**
   * Test seam: the helper that blocks until the parent receives
   * SIGINT in any of the three "stay UP for operator recovery"
   * branches (no-planId, EXIT_PAUSED, drive-failure). Production
   * uses the real helper that registers a SIGINT listener; tests
   * inject a resolver that returns immediately so they don't hang.
   */
  stayUpUntilSigint?: () => Promise<void>
}

/**
 * `pm-go implement` dispatcher. Loads .env, parses argv, builds the
 * supervisor + drive deps, then invokes `runSupervisor` with an
 * `onReady` callback that fires `runDrive` against the captured
 * planId. The supervisor's children are torn down gracefully when
 * drive completes; the exit code is drive's.
 */
export async function implementCli(cliDeps: ImplementCliDeps): Promise<number> {
  // Load .env BEFORE argv parsing so DATABASE_URL / API_PORT defaults
  // pick up values placed in the file. Log the summary up front (even
  // for --help) so the user always knows whether their .env was
  // picked up.
  if (cliDeps.applyDotenv) {
    const r = await cliDeps.applyDotenv(`${cliDeps.monorepoRoot}/.env`)
    if (r.loaded) {
      cliDeps.log(
        `[pm-go] loaded .env (${r.applied.length} applied, ${r.skipped.length} pre-set in shell)`,
      )
    }
  }

  const parsed = parseImplementArgv(cliDeps.argv, cliDeps.cwd, cliDeps.resolve)
  if (!parsed.ok) {
    if (parsed.error === 'help') {
      cliDeps.log(IMPLEMENT_USAGE)
      return 0
    }
    cliDeps.errLog(`pm-go implement: ${parsed.error}`)
    cliDeps.errLog('')
    cliDeps.errLog(IMPLEMENT_USAGE)
    return 2
  }

  const pm = createProcessManager({
    process,
    log: (l) => cliDeps.errLog(l),
    // Mirror run.ts: the same removeInstanceState the buildSupervisorDeps
    // half uses for write is wired into the PM so SIGINT / a clean
    // drive-completion stop deletes the state file along with the
    // children.
    ...(cliDeps.removeInstanceState
      ? { removeInstanceState: cliDeps.removeInstanceState }
      : {}),
  })
  const supervisorDeps: RunDeps = {
    ...cliDeps.buildSupervisorDeps(pm),
    pm,
    monorepoRoot: cliDeps.monorepoRoot,
  }

  // Translate ImplementOptions to RunOptions (every field aligns;
  // approve is consumed downstream by drive).
  const runOptions: RunOptions = {
    repoRoot: parsed.options.repoRoot,
    specPath: parsed.options.specPath,
    title: parsed.options.title,
    runtime: parsed.options.runtime,
    apiPort: parsed.options.apiPort,
    databaseUrl: parsed.options.databaseUrl,
    skipDocker: parsed.options.skipDocker,
    skipMigrate: parsed.options.skipMigrate,
  }

  const driveDeps = cliDeps.buildDriveDeps()

  // Test seam: callers can substitute a fake runSupervisor. Defaults
  // to the real implementation imported above.
  const runSupervisor = cliDeps.runSupervisor ?? runSupervisorImpl

  // Test seam: callers can substitute a no-op resolver for the SIGINT
  // wait so unit tests don't hang. Production uses the real helper
  // that registers a SIGINT listener.
  const stayUp = cliDeps.stayUpUntilSigint ?? stayUpUntilSigint

  return runSupervisor(runOptions, supervisorDeps, async (handle) => {
    if (!handle.planId) {
      // Two ways we can land here:
      //   (a) Spec submission errored hard (HTTP 4xx/5xx) — the
      //       supervisor already logged the failure and there's
      //       nothing to drive against. Tearing the stack down is
      //       fine but unhelpful; the operator usually wants the API
      //       up so they can re-submit a corrected spec.
      //   (b) Plan-persistence wait timed out (20-minute ceiling).
      //       The plan was almost certainly persisted under a
      //       different UUID (see the recovery-message logged by
      //       submitSpecAndPlan); the operator MUST keep the API
      //       running to look it up and resume with `pm-go drive`.
      // In both cases the right move is to STAY UP and wait for
      // SIGINT — never tear children down out from under a recovery
      // session that has no other way to find the real plan id.
      cliDeps.errLog(
        '[implement] supervisor finished boot but did not capture a planId. ' +
          'See the log above for details. Stack is staying UP so you can ' +
          'recover (find the plan id and run `pm-go drive --plan <id>`, ' +
          'or re-submit a corrected spec).',
      )
      cliDeps.log('             Press Ctrl+C to stop the supervisor when done.')
      cliDeps.log('')
      await stayUp()
      cliDeps.log('[implement] received Ctrl+C; releasing supervisor')
      return 1
    }

    // Extend the supervisor's per-instance state file with a `drive`
    // entry now that we're about to start running the drive loop.
    // `pm-go ps` will then report drive alongside supervisor / worker
    // / api; the process-manager removes the whole file atomically on
    // teardown, so the entry never outlives this process.
    const drivePid = cliDeps.drivePid ?? process.pid
    await handle.writeInstanceState({ label: 'drive', pid: drivePid })

    cliDeps.log('')
    cliDeps.log(
      `[implement] driving plan ${handle.planId} (--approve ${parsed.options.approve})`,
    )
    cliDeps.log('')

    const driveOptions: DriveOptions = {
      planId: handle.planId,
      apiUrl: handle.apiUrl,
      approve: parsed.options.approve,
    }
    const code = await runDrive(driveOptions, driveDeps)

    // v0.8.4.1 P2.2: when drive returns EXIT_PAUSED (an approval was
    // declined or --approve none surfaced a pending row), the
    // operator now needs the API + worker to STAY UP so they can
    // resolve the approval via the TUI / API and then re-run drive.
    // Pre-fix: implement returned to the supervisor which immediately
    // tore everything down, leaving the operator with no way to act
    // on the message they'd just been told to act on.
    if (code === EXIT_PAUSED) {
      cliDeps.log('')
      cliDeps.log(
        '[implement] drive paused waiting for an approval — stack is staying UP.',
      )
      cliDeps.log(
        `             Resolve via:  curl -X POST ${handle.apiUrl}/plans/${handle.planId}/approve-all-pending \\`,
      )
      cliDeps.log(
        `                            -H 'content-type: application/json' \\`,
      )
      cliDeps.log(
        `                            -d '{"approvedBy":"<you>","reason":"<why>"}'`,
      )
      cliDeps.log(
        `             Or open the TUI: pnpm tui   (find plan ${handle.planId}, press g A)`,
      )
      cliDeps.log(
        `             Then re-run drive:  pnpm pm-go drive --plan ${handle.planId}`,
      )
      cliDeps.log('             Press Ctrl+C to stop the supervisor when done.')
      cliDeps.log('')
      // Block until the operator sends SIGINT. The supervisor's
      // signal handler will fire afterwards and tear down children
      // cleanly.
      await stayUp()
      cliDeps.log('[implement] received Ctrl+C; releasing supervisor')
      return EXIT_PAUSED
    }

    // v0.8.7.1: drive-failure fail-open. Any non-zero, non-EXIT_PAUSED
    // exit means drive hit a real failure mid-loop (e.g. a 409 from
    // /tasks/:id/run because the phase wasn't yet `executing`, an
    // audit-blocked plan, a wait timeout). Pre-fix the supervisor
    // tore down api+worker on its way out, leaving the operator with
    // no stack to diagnose against. Now the stack stays UP so the
    // operator can use `pm-go why <plan-id>` to see the root cause
    // and `pm-go drive --plan <id>` to resume after fixing it.
    if (code !== 0) {
      cliDeps.log('')
      cliDeps.log(
        `[implement] drive exited code=${code}; the plan is still in the database. Stack staying UP for diagnosis.`,
      )
      cliDeps.log(`             Diagnose:    pm-go why ${handle.planId}`)
      cliDeps.log(
        `             Resume:      pm-go drive --plan ${handle.planId} --approve ${parsed.options.approve}`,
      )
      cliDeps.log('             Press Ctrl+C to stop the supervisor when done.')
      cliDeps.log('')
      await stayUp()
      cliDeps.log('[implement] received Ctrl+C; releasing supervisor')
      return code
    }

    cliDeps.log('')
    cliDeps.log('[implement] drive completed; releasing supervisor')
    return code
  })
}

/**
 * Block until the parent process receives SIGINT. The handler is
 * one-shot — it removes itself before resolving so the supervisor's
 * own SIGINT handler still fires afterwards and tears children down
 * cleanly. Used by every "stay UP for operator recovery" branch in
 * `implementCli` (no-planId, EXIT_PAUSED, and v0.8.7.1's drive-failure
 * branch); extracted so the three branches share one source of truth
 * for the wait pattern.
 */
async function stayUpUntilSigint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSig = () => {
      process.removeListener('SIGINT', onSig)
      resolve()
    }
    process.once('SIGINT', onSig)
  })
}
