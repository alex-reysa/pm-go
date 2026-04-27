/**
 * `pm-go stop` — graceful shutdown of every tracked pm-go child.
 *
 * Reads each instance state file, sends SIGTERM to every PID inside,
 * waits up to `--grace-ms` (default 5000) for them to exit, sends
 * SIGKILL to any survivor, and removes the state file. Idempotent
 * when no state files exist — the command prints
 * `(no pm-go instances)` and exits 0 so it composes safely in shell
 * scripts that may run it speculatively.
 *
 * `--instance <name>` scopes the operation to a single instance,
 * matched by either its logical name or its `apiPort` (so an operator
 * who only remembers the port can still target the right stack).
 *
 * All side-effecting calls go through StopDeps so the unit test can
 * assert exactly which PIDs received SIGTERM/SIGKILL without spawning
 * real children.
 */

import type { InstanceState } from './ps.js'

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface StopOptions {
  /** Optional instance filter — name OR stringified apiPort. */
  instance?: string
  /** Milliseconds to wait between SIGTERM and SIGKILL. */
  graceMs: number
}

export interface ParsedStopArgv {
  ok: true
  options: StopOptions
}

export interface StopArgvError {
  ok: false
  error: string
}

const DEFAULT_GRACE_MS = 5_000

export function parseStopArgv(
  argv: readonly string[],
): ParsedStopArgv | StopArgvError {
  const opts: StopOptions = { graceMs: DEFAULT_GRACE_MS }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    switch (flag) {
      case '--instance':
        if (!value) return { ok: false, error: `${flag} requires a value` }
        opts.instance = value
        i++
        break
      case '--grace-ms': {
        if (!value) return { ok: false, error: `${flag} requires a number` }
        const n = Number.parseInt(value, 10)
        if (!Number.isInteger(n) || n < 0 || n > 600_000) {
          return {
            ok: false,
            error: `${flag} must be an integer 0..600000`,
          }
        }
        opts.graceMs = n
        i++
        break
      }
      case '-h':
      case '--help':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }
  return { ok: true, options: opts }
}

// ---------------------------------------------------------------------------
// Side-effect deps
// ---------------------------------------------------------------------------

export interface StopDeps {
  /** Enumerate every instance state file currently on disk. */
  listInstanceStates: () => Promise<InstanceState[]>
  /** Remove the state file for the named instance (idempotent). */
  removeStateFile: (instance: string) => Promise<void>
  /**
   * Send `signal` to `pid`. `0` is a no-op existence probe, mirroring
   * `process.kill`. Returns true when the call succeeded; false when
   * the PID was already gone (ESRCH) or the OS rejected the call.
   */
  kill: (pid: number, signal: 'SIGTERM' | 'SIGKILL' | 0) => boolean
  /** Existence probe — equivalent to `kill(pid, 0)` but easier to mock. */
  isAlive: (pid: number) => boolean
  /** Sleep — used between SIGTERM and the survivor sweep. */
  sleep: (ms: number) => Promise<void>
  /** Wall-clock provider — drives the polling deadline. */
  now: () => number
  /** Output sink — one call per line. */
  write: (line: string) => void
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** How often to re-check survivors during the grace window. */
const POLL_INTERVAL_MS = 100

/**
 * Filter the on-disk state files down to the instance the operator
 * asked for. Matches by name first, then falls back to apiPort
 * (stringified) so `--instance 3001` works without remembering
 * the logical name.
 */
function filterByInstance(
  states: readonly InstanceState[],
  instance: string | undefined,
): InstanceState[] {
  if (instance === undefined) return [...states]
  return states.filter(
    (s) => s.instance === instance || String(s.apiPort) === instance,
  )
}

/**
 * Stop a single instance: SIGTERM → poll → SIGKILL survivors → remove
 * state file. Always removes the file on exit so a partial failure
 * doesn't leave a stale state hanging around for `pm-go ps` to misreport.
 */
async function stopOne(
  state: InstanceState,
  graceMs: number,
  deps: StopDeps,
): Promise<{ termed: number[]; killed: number[] }> {
  const pids = state.entries.map((e) => e.pid)
  const termed: number[] = []
  const killed: number[] = []

  if (pids.length === 0) {
    await deps.removeStateFile(state.instance)
    return { termed, killed }
  }

  // Phase 1 — SIGTERM every tracked PID.
  for (const pid of pids) {
    // Skip already-dead PIDs so we don't spuriously claim to have
    // signalled a process that crashed before we got here.
    if (!deps.isAlive(pid)) continue
    try {
      const ok = deps.kill(pid, 'SIGTERM')
      if (ok) termed.push(pid)
    } catch {
      // ESRCH or EPERM — the process is unreachable; let the survivor
      // sweep treat it as already-gone.
    }
  }

  // Phase 2 — wait up to graceMs for everything to exit. Poll every
  // POLL_INTERVAL_MS so we can short-circuit the wait when all
  // children exit cleanly (and so the unit test doesn't have to fake
  // a 5s sleep).
  const deadline = deps.now() + graceMs
  while (deps.now() < deadline) {
    const survivors = pids.filter((pid) => deps.isAlive(pid))
    if (survivors.length === 0) break
    const remaining = deadline - deps.now()
    if (remaining <= 0) break
    await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining))
  }

  // Phase 3 — SIGKILL survivors. The unit-test for "all exited cleanly"
  // asserts this loop is a no-op (kill is never invoked with SIGKILL).
  for (const pid of pids) {
    if (!deps.isAlive(pid)) continue
    try {
      const ok = deps.kill(pid, 'SIGKILL')
      if (ok) killed.push(pid)
    } catch {
      // ignore
    }
  }

  // Phase 4 — remove the state file regardless of how the kills went.
  // Leaving it behind would cause future `pm-go ps` calls to surface
  // ghost rows.
  await deps.removeStateFile(state.instance)
  return { termed, killed }
}

export async function runStop(
  options: StopOptions,
  deps: StopDeps,
): Promise<number> {
  const allStates = await deps.listInstanceStates()
  const states = filterByInstance(allStates, options.instance)

  if (states.length === 0) {
    deps.write('  (no pm-go instances)')
    return 0
  }

  for (const state of states) {
    deps.write(
      `[stop] instance=${state.instance} apiPort=${state.apiPort} pids=${state.entries
        .map((e) => `${e.label}:${e.pid}`)
        .join(',') || '(none)'}`,
    )
    const { termed, killed } = await stopOne(state, options.graceMs, deps)
    deps.write(
      `[stop] instance=${state.instance} sigterm=${termed.length} sigkill=${killed.length} state-file removed`,
    )
  }

  return 0
}

export const STOP_USAGE = `Usage: pm-go stop [--instance <name|port>] [--grace-ms <n>]

Stop every tracked pm-go child by SIGTERM, wait up to --grace-ms
(default 5000) for graceful exit, SIGKILL any survivor, then remove
the on-disk instance state file. Idempotent when no state file
exists — prints "(no pm-go instances)" and exits 0.

Options:
  --instance <name|port>  Only stop the named (or apiPort-matched) instance.
  --grace-ms <n>          Milliseconds between SIGTERM and SIGKILL (default 5000).
  -h, --help              Show this message.`
