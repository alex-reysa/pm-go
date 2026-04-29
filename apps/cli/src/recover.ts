/**
 * `pm-go recover` — drive a wedged plan back to a clean state.
 *
 * Operator-facing recovery for the four most common stuck-plan modes
 * we have seen in dogfood:
 *
 *   1. API down — the supervisor crashed before the workflow finished.
 *      Restart it via the supervisor entry-point and exit; the workflow
 *      itself is durable and resumes on its own once Temporal can
 *      reach the activities again.
 *
 *   2. Running workflow — Temporal still has a live workflow for this
 *      plan but the CLI lost track of it (e.g. drive crashed). Attach
 *      to the workflow id and wait for it to finish so the operator
 *      sees the same outcome they would have seen from the original
 *      drive call.
 *
 *   3. Completed-but-unprojected — the workflow signalled completion
 *      but the projection activity that flips Postgres rows didn't
 *      run (network blip, projection bug). Re-run the projection
 *      activity and exit.
 *
 *   4. Nothing salvageable — the workflow is gone or in a state we
 *      can't reason about. Print a manual-recovery hint that tells the
 *      operator exactly what to run, with `--repo` shell-quoted so a
 *      path like `/tmp/with space/repo` survives a copy-paste into a
 *      shell. (See `shellQuotePath` below — that escape rule is the
 *      Phase-0 helper this module's hint relies on.)
 *
 * `--dry-run` prints the decision tree without invoking any
 * side-effecting dep, so an operator can sanity-check the plan before
 * actually mutating state.
 *
 * All side-effecting calls (HTTP fetch, Temporal client, supervisor
 * restart, projection rerun) live behind RecoverDeps so the four-branch
 * unit test can drive them with synchronous mocks.
 *
 * The first GET against the API base URL goes through
 * `probePmGoApi` from `./lib/api-client.js`. probePmGoApi wraps every
 * failure (transport, HTTP non-2xx, identity mismatch) into a single
 * PmGoIdentityMismatchError; for recover's purposes we then split
 * those failures: a transport-class failure (network, HTTP non-2xx,
 * unreadable body) keeps the legacy "API down → restart supervisor"
 * branch, while a 2xx whose body is not the pm-go identity envelope
 * is reclassified as "foreign service holds our port" — runRecover
 * surfaces the structured error (whose first line begins with
 * `[pm-go] port <port> is held by another service`) and exits 1
 * without invoking any side-effect dep. The classifier consults
 * the error's `message` substring (`network error:` / `HTTP <num>` /
 * `failed to read response body:`) — those substrings are part of
 * probePmGoApi's documented message format.
 */

import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from './lib/api-client.js'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface RecoverOptions {
  /** UUID of the plan to recover. */
  planId: string
  /** API base URL — passed through to deps.fetch. */
  apiUrl: string
  /** When true, every side-effecting dep is skipped. */
  dryRun: boolean
}

export interface ParsedRecoverArgv {
  ok: true
  options: RecoverOptions
}

export interface RecoverArgvError {
  ok: false
  error: string
}

const DEFAULT_API_PORT = 3001

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseRecoverArgv(
  argv: readonly string[],
): ParsedRecoverArgv | RecoverArgvError {
  let planId: string | undefined
  let port: number | undefined
  let apiUrl: string | undefined
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--plan':
        if (!value) return { ok: false, error: `${flag} requires a UUID` }
        if (!UUID_RE.test(value)) {
          return { ok: false, error: `${flag} must be a UUID` }
        }
        planId = value
        i++
        break
      case '--port':
      case '-p': {
        if (!value) return { ok: false, error: `${flag} requires a number` }
        const n = Number.parseInt(value, 10)
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          return { ok: false, error: `${flag} must be an integer 1..65535` }
        }
        port = n
        i++
        break
      }
      case '--api-url':
        if (!value) return { ok: false, error: `${flag} requires a URL` }
        apiUrl = value.replace(/\/+$/, '')
        i++
        break
      case '--dry-run':
        dryRun = true
        break
      case '-h':
      case '--help':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }

  if (!planId) {
    return { ok: false, error: '--plan <uuid> is required' }
  }

  return {
    ok: true,
    options: {
      planId,
      apiUrl: apiUrl ?? `http://localhost:${port ?? DEFAULT_API_PORT}`,
      dryRun,
    },
  }
}

// ---------------------------------------------------------------------------
// Workflow descriptor — narrow read-model of what we need from Temporal.
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'terminated'
  | 'canceled'
  | 'timed_out'
  | 'continued_as_new'
  | 'not_found'

export interface WorkflowDescription {
  status: WorkflowStatus
  /** Set when status !== 'not_found'. */
  workflowId?: string
  runId?: string
}

// ---------------------------------------------------------------------------
// Side-effect deps
// ---------------------------------------------------------------------------

export interface RecoverDeps {
  /** HTTP fetch — used to detect API down vs. up. */
  fetch: typeof globalThis.fetch
  /**
   * Look up the SpecToPlan / PlanRelease workflow for the given plan.
   * Tests inject a stub that returns a synthetic WorkflowDescription;
   * production wires this to the Temporal client.
   */
  describeWorkflow: (planId: string) => Promise<WorkflowDescription>
  /**
   * Attach to a running workflow and wait for it to finish. Returns
   * the workflow's terminal outcome string.
   */
  attachAndWait: (
    workflowId: string,
    runId: string,
  ) => Promise<{ outcome: string }>
  /**
   * Re-run the projection activity that flips Postgres rows after a
   * workflow signals completion. Used by the
   * "completed-but-unprojected" branch.
   */
  rerunProjection: (planId: string) => Promise<void>
  /**
   * Restart the local supervisor. Production wires this to the same
   * runSupervisor entry point used by `pm-go run`.
   */
  startSupervisor: (apiPort: number) => Promise<void>
  /** Repo path used to render manual-recovery hints. */
  repoRoot: string
  /** Output sink — one call per line. */
  write: (line: string) => void
}

// ---------------------------------------------------------------------------
// Phase-0 shell-quoting helper
// ---------------------------------------------------------------------------

/**
 * Single-quote a path so it survives copy-paste into a POSIX shell.
 * Wraps in `'...'` and escapes any embedded single-quote with the
 * canonical `'\\''` dance so a path like `/tmp/with space/repo` or
 * `/srv/foo's bar` survives without further interpretation. This is
 * the same pattern `status.ts`'s shellQuote uses, lifted here under
 * the name the task contract refers to (`shellQuotePath`).
 *
 * Exported so the unit test can feed it pathological inputs.
 */
export function shellQuotePath(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

// ---------------------------------------------------------------------------
// Decision tree
// ---------------------------------------------------------------------------

export type RecoverBranch =
  | 'api-down'
  | 'running-workflow'
  | 'completed-unprojected'
  | 'nothing-salvageable'

/**
 * Discriminate a `PmGoIdentityMismatchError` into the two cases recover
 * cares about: a *transport* failure (network error, HTTP non-2xx,
 * unreadable body) means the supervisor isn't actually answering and
 * we should fall through to the api-down branch; anything else means
 * the API answered 2xx with a body that isn't the pm-go identity
 * envelope, i.e. another service is squatting on our port. The
 * substrings we match (`network error:`, `HTTP \d+`,
 * `failed to read response body:`) are produced verbatim by
 * `probePmGoApi`'s `fail(...)` calls; they're stable enough to
 * dispatch on, and `apps/cli/src/__tests__/api-client.test.ts` keeps
 * them honest.
 */
function isApiTransportFailure(err: PmGoIdentityMismatchError): boolean {
  return (
    err.message.includes('network error:') ||
    /HTTP \d+/.test(err.message) ||
    err.message.includes('failed to read response body:')
  )
}

/**
 * Probe the API and Temporal to decide which recovery branch applies.
 * Pure on inputs (no mutation), so the unit test can call it directly
 * for each scenario.
 *
 * Throws `PmGoIdentityMismatchError` (untouched, prefix-bearing) when
 * the API answers 2xx with a body that isn't pm-go's identity
 * envelope. `runRecover` catches it and exits 1 without invoking
 * `startSupervisor` / `attachAndWait` / `rerunProjection`.
 */
export async function diagnoseRecovery(
  options: RecoverOptions,
  deps: RecoverDeps,
): Promise<{ branch: RecoverBranch; workflow: WorkflowDescription | null }> {
  // 1. API reachability + identity. probePmGoApi covers both: a
  //    network/HTTP/body-read failure means the API isn't really up
  //    (api-down branch); a 2xx body that fails identity validation
  //    means a foreign service holds our port (re-thrown for
  //    runRecover to surface and exit 1). We wrap deps.fetch in a
  //    timeout-injecting shim so the prior 3s timeout behaviour is
  //    preserved — probePmGoApi calls fetchImpl(url) without an init,
  //    so this is the only seam where the signal can be plumbed.
  const probeFetch: typeof globalThis.fetch = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    deps.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(3000),
    })) as typeof globalThis.fetch
  try {
    await probePmGoApi(probeFetch, `${options.apiUrl}/health`)
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      if (isApiTransportFailure(err)) {
        return { branch: 'api-down', workflow: null }
      }
      throw err
    }
    throw err
  }

  // 2. API is up — ask Temporal what the workflow looks like.
  const wf = await deps.describeWorkflow(options.planId)
  if (wf.status === 'running') {
    return { branch: 'running-workflow', workflow: wf }
  }
  if (wf.status === 'completed') {
    // 3. Workflow says done. Confirm we can read the plan row at all
    //    before claiming the completed-unprojected branch — if the API
    //    can't surface the plan, we have no signal to act on and fall
    //    through to nothing-salvageable. We don't gate on
    //    `status === 'released'` here: the rerun-projection activity is
    //    idempotent, so re-running it on an already-projected plan is
    //    safe and saves us a special-case branch.
    const planRes = await deps
      .fetch(`${options.apiUrl}/plans/${options.planId}`)
      .catch(() => null)
    if (planRes && planRes.ok) {
      // Drain the body so the fetch mock's response is fully consumed,
      // even though we don't branch on its contents anymore.
      await planRes.json().catch(() => null)
      return { branch: 'completed-unprojected', workflow: wf }
    }
    // Couldn't read the plan row — fall through to nothing-salvageable.
    return { branch: 'nothing-salvageable', workflow: wf }
  }

  // 4. Anything else (failed / terminated / canceled / not_found) is
  //    not auto-recoverable.
  return { branch: 'nothing-salvageable', workflow: wf }
}

/**
 * Print the manual-recovery hint for the nothing-salvageable branch.
 * The hint quotes the repo root with `shellQuotePath` so an operator
 * can paste the command verbatim regardless of whether their repo
 * lives at `/srv/proj` or `/tmp/with space/repo`.
 */
export function renderManualHint(
  options: RecoverOptions,
  repoRoot: string,
): string[] {
  return [
    'No automatic recovery available. Manual steps:',
    `  1. Inspect the plan:    curl ${options.apiUrl}/plans/${options.planId} | jq`,
    `  2. Bring the stack up:  pm-go run --repo ${shellQuotePath(repoRoot)}`,
    `  3. Re-drive the plan:   pm-go drive --plan ${options.planId}`,
  ]
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runRecover(
  options: RecoverOptions,
  deps: RecoverDeps,
): Promise<number> {
  deps.write('')
  deps.write(`pm-go recover plan=${options.planId}${options.dryRun ? ' (dry-run)' : ''}`)
  deps.write('─'.repeat(42))

  // diagnoseRecovery throws PmGoIdentityMismatchError when the /health
  // response is 2xx but the body isn't pm-go's identity envelope —
  // i.e. another service holds our port. Surface the structured
  // message verbatim and exit 1 BEFORE invoking any side-effect dep:
  // the AC explicitly requires no startSupervisor / attachAndWait /
  // rerunProjection / describeWorkflow request against a foreign
  // target.
  let branchOutcome: { branch: RecoverBranch; workflow: WorkflowDescription | null }
  try {
    branchOutcome = await diagnoseRecovery(options, deps)
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      for (const line of err.message.split('\n')) {
        deps.write(line)
      }
      return 1
    }
    throw err
  }
  const { branch, workflow } = branchOutcome

  // The apiPort is encoded in apiUrl; pull it out for startSupervisor.
  // A malformed URL falls back to the default port — better than
  // throwing inside the dry-run preview.
  const apiPort = (() => {
    try {
      return Number.parseInt(new URL(options.apiUrl).port, 10) || DEFAULT_API_PORT
    } catch {
      return DEFAULT_API_PORT
    }
  })()

  switch (branch) {
    case 'api-down': {
      deps.write('  diagnosis: API /health unreachable')
      deps.write(`  action:    restart supervisor on port ${apiPort}`)
      if (options.dryRun) {
        deps.write('  (dry-run: not invoking startSupervisor)')
        return 0
      }
      await deps.startSupervisor(apiPort)
      return 0
    }
    case 'running-workflow': {
      deps.write(`  diagnosis: workflow ${workflow?.workflowId ?? '(unknown)'} still running`)
      deps.write('  action:    attach and wait for terminal status')
      if (options.dryRun) {
        deps.write('  (dry-run: not invoking attachAndWait)')
        return 0
      }
      if (!workflow?.workflowId || !workflow?.runId) {
        deps.write('  ✗ workflow descriptor missing workflowId/runId — cannot attach')
        return 1
      }
      const result = await deps.attachAndWait(workflow.workflowId, workflow.runId)
      deps.write(`  outcome:   ${result.outcome}`)
      return 0
    }
    case 'completed-unprojected': {
      deps.write('  diagnosis: workflow completed; projection may not have landed')
      deps.write('  action:    re-run projection activity')
      if (options.dryRun) {
        deps.write('  (dry-run: not invoking rerunProjection)')
        return 0
      }
      await deps.rerunProjection(options.planId)
      return 0
    }
    case 'nothing-salvageable': {
      deps.write('  diagnosis: nothing salvageable from automated recovery')
      // Manual hint always uses shellQuotePath for the repo so a
      // paste-into-shell survives unusual paths.
      for (const line of renderManualHint(options, deps.repoRoot)) {
        deps.write(line)
      }
      return 1
    }
  }
}

export const RECOVER_USAGE = `Usage: pm-go recover --plan <uuid> [options]

Drive a wedged plan back to a clean state by walking a four-branch
decision tree: API down → restart supervisor; running workflow →
attach and wait; completed-but-unprojected → re-run projection;
nothing salvageable → print a copy-pasteable manual hint.

Options:
  --plan <uuid>           Plan id to recover (required).
  --port, -p <n>          API port (default: 3001).
  --api-url <url>         API base URL (default: http://localhost:<port>).
  --dry-run               Print the diagnosis without invoking any side-effect.
  -h, --help              Show this message.`
