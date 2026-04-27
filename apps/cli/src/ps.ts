/**
 * `pm-go ps` — process listing for the local pm-go control plane.
 *
 * Reads instance state files (one per running `pm-go run` invocation),
 * cross-references each tracked PID against the live process table,
 * and prints a compact LABEL/PID/PORT/UPTIME/INSTANCE table. Anything
 * whose PID is no longer alive is moved to a separate "Stale" section
 * so an operator can spot crashed children at a glance — they are the
 * primary input to `pm-go recover`.
 *
 * `--json` emits a stable shape consumers can pipe into `jq`. The
 * field set is deliberately a thin projection of the on-disk
 * InstanceState so future fields can be added without breaking older
 * scripts that only read `pid` / `port`.
 *
 * All I/O is injected via PsDeps so unit tests can run without
 * touching the home dir or spawning real processes.
 */

// ---------------------------------------------------------------------------
// Instance-state shape
// ---------------------------------------------------------------------------

/**
 * One tracked child inside an instance state file. `port` is undefined
 * for entries that don't bind a port (e.g. the `drive` client process).
 */
export interface InstanceStateEntry {
  /** Short label — `worker`, `api`, `drive`, etc. */
  label: string
  /** OS process id. */
  pid: number
  /** TCP port the process listens on, when applicable. */
  port?: number
  /** ISO-8601 timestamp at which the supervisor recorded the entry. */
  startedAt: string
}

/**
 * On-disk instance state. One file per `pm-go run` invocation; the
 * supervisor writes it after spawning its children and removes it on
 * graceful shutdown.
 */
export interface InstanceState {
  /** Logical instance name (e.g. `default`, `scratch`). */
  instance: string
  /** API port for this instance — also the natural unique key. */
  apiPort: number
  /** Tracked children. */
  entries: InstanceStateEntry[]
}

// ---------------------------------------------------------------------------
// JSON output shape (stable — consumers may depend on field names)
// ---------------------------------------------------------------------------

export interface PsJsonRow {
  instance: string
  apiPort: number
  label: string
  pid: number
  /** null when the entry has no associated port. */
  port: number | null
  startedAt: string
  /** null when the PID is no longer alive (we can't measure uptime). */
  uptimeMs: number | null
}

export interface PsJsonOutput {
  live: PsJsonRow[]
  stale: PsJsonRow[]
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

export interface PsOptions {
  json: boolean
}

export interface ParsedPsArgv {
  ok: true
  options: PsOptions
}

export interface PsArgvError {
  ok: false
  error: string
}

export function parsePsArgv(
  argv: readonly string[],
): ParsedPsArgv | PsArgvError {
  let json = false
  for (const flag of argv) {
    switch (flag) {
      case '--json':
        json = true
        break
      case '-h':
      case '--help':
        return { ok: false, error: 'help' }
      default:
        return { ok: false, error: `unknown flag: ${flag}` }
    }
  }
  return { ok: true, options: { json } }
}

// ---------------------------------------------------------------------------
// Side-effect deps
// ---------------------------------------------------------------------------

export interface PsDeps {
  /** Enumerate every instance state file currently on disk. */
  listInstanceStates: () => Promise<InstanceState[]>
  /**
   * Return true if the given PID is still alive. Production wires
   * this to `process.kill(pid, 0)` (signal 0 = existence probe).
   */
  isAlive: (pid: number) => boolean
  /** Wall-clock provider — injected so tests can pin uptime values. */
  now: () => number
  /** Output sink — one call per line. */
  write: (line: string) => void
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const DIVIDER = '─'.repeat(42)

/**
 * Format an uptime in HH:MM:SS. Negative durations (clock skew) are
 * clamped to 0 so the column never widens unexpectedly.
 */
function formatUptime(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${pad(h)}:${pad(m)}:${pad(s)}`
}

/**
 * Build a fixed-width row for the text-mode table. Widths are picked
 * so a typical worker/api/drive row fits in ~80 columns even when
 * PIDs reach 5 digits.
 */
function formatRow(
  label: string,
  pid: string,
  port: string,
  uptime: string,
  instance: string,
): string {
  return `  ${label.padEnd(8)} ${pid.padEnd(7)} ${port.padEnd(6)} ${uptime.padEnd(10)} ${instance}`
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runPs(
  options: PsOptions,
  deps: PsDeps,
): Promise<number> {
  const states = await deps.listInstanceStates()
  const live: PsJsonRow[] = []
  const stale: PsJsonRow[] = []

  for (const state of states) {
    for (const entry of state.entries) {
      const startedAtMs = Date.parse(entry.startedAt)
      const isAlive = deps.isAlive(entry.pid)
      // Date.parse returns NaN on bad input — treat as "uptime unknown"
      // rather than crashing the whole listing on a single bad row.
      const uptimeMs =
        isAlive && Number.isFinite(startedAtMs)
          ? deps.now() - startedAtMs
          : null
      const row: PsJsonRow = {
        instance: state.instance,
        apiPort: state.apiPort,
        label: entry.label,
        pid: entry.pid,
        port: entry.port ?? null,
        startedAt: entry.startedAt,
        uptimeMs,
      }
      if (isAlive) live.push(row)
      else stale.push(row)
    }
  }

  if (options.json) {
    const out: PsJsonOutput = { live, stale }
    deps.write(JSON.stringify(out, null, 2))
    return 0
  }

  // Text mode.
  deps.write('pm-go ps')
  deps.write(DIVIDER)
  deps.write('')

  if (live.length === 0 && stale.length === 0) {
    deps.write('  (no pm-go instances)')
    return 0
  }

  deps.write('Live')
  deps.write(formatRow('LABEL', 'PID', 'PORT', 'UPTIME', 'INSTANCE'))
  if (live.length === 0) {
    deps.write('  (none)')
  } else {
    for (const row of live) {
      deps.write(
        formatRow(
          row.label,
          String(row.pid),
          row.port === null ? '-' : String(row.port),
          row.uptimeMs === null ? '-' : formatUptime(row.uptimeMs),
          row.instance,
        ),
      )
    }
  }

  if (stale.length > 0) {
    deps.write('')
    deps.write('Stale (dead PIDs in state files)')
    deps.write(formatRow('LABEL', 'PID', 'PORT', 'UPTIME', 'INSTANCE'))
    for (const row of stale) {
      deps.write(
        formatRow(
          row.label,
          String(row.pid),
          row.port === null ? '-' : String(row.port),
          '-',
          row.instance,
        ),
      )
    }
    deps.write('')
    deps.write('  hint: `pm-go stop` clears stale state; `pm-go recover` re-attaches.')
  }

  return 0
}

export const PS_USAGE = `Usage: pm-go ps [--json]

List the worker / api / drive processes tracked in the local instance
state files, with PID, port, uptime, and instance name. Dead PIDs are
moved to a separate Stale section so crashes are visible at a glance.

Options:
  --json      Emit machine-readable JSON instead of the text table.
  -h, --help  Show this message.`
