/**
 * Tracked child-process group for the `pm-go run` supervisor. Owns
 * SIGINT/SIGTERM forwarding so a `Ctrl+C` cleanly stops the worker
 * and API even when they were spawned through pnpm filters that
 * fork an extra layer of processes.
 *
 * Deliberately tiny: the supervisor needs lifecycle management, not
 * a full process tree like pm2.
 */

import type { ChildProcess } from 'node:child_process'

export interface TrackedChild {
  /** Short label for log lines and shutdown messages. */
  label: string
  /** The underlying ChildProcess from `node:child_process`. */
  proc: ChildProcess
  /** Promise that resolves when the child exits. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

export interface ProcessManagerDeps {
  /** Process-level signal sink — defaults to `process` in production. */
  process: Pick<NodeJS.Process, 'on' | 'off' | 'kill' | 'pid'>
  /** Output sink — defaults to console.error in production. */
  log: (line: string) => void
}

/**
 * Wrap a ChildProcess so it can be tracked and shut down with the
 * rest of the group. Adds a single `exit` promise consumers can
 * await to detect crashes.
 */
export function track(label: string, proc: ChildProcess): TrackedChild {
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      proc.on('exit', (code, signal) => resolve({ code, signal }))
    },
  )
  return { label, proc, exit }
}

/**
 * Create a process-group manager that:
 *   1. Registers SIGINT + SIGTERM handlers exactly once.
 *   2. On signal, sends SIGTERM to every tracked child, waits up to
 *      `gracePeriodMs`, then sends SIGKILL to anything still running.
 *   3. Exits the parent process with the signal-derived exit code so
 *      shells see the supervisor as terminated, not as exit 0.
 *
 * Two stop paths:
 *   - `shutdown(reason, code)` — SIGINT/SIGTERM handler. Stops children
 *     AND calls `process.exit`. Used when the user kills the supervisor.
 *   - `stop(reason)` — graceful no-exit teardown. Stops children but
 *     returns control to the caller so it can pick its own exit code.
 *     Used by `pm-go implement` when the drive loop completes
 *     successfully and we want to return the drive's exit code rather
 *     than the supervisor's.
 */
export interface ProcessManager {
  add(child: TrackedChild): void
  shutdown(reason: string, exitCode?: number): Promise<never>
  stop(reason: string): Promise<void>
  /** True after `shutdown` or `stop` has been initiated. Idempotency guard. */
  readonly shuttingDown: boolean
}

export function createProcessManager(
  deps: ProcessManagerDeps,
  gracePeriodMs = 5_000,
): ProcessManager {
  const children: TrackedChild[] = []
  let shuttingDown = false

  async function tearDownChildren(reason: string): Promise<void> {
    deps.log(`[pm-go] ${reason}; stopping ${children.length} child process(es)`)
    for (const c of children) {
      try {
        c.proc.kill('SIGTERM')
      } catch {
        // already gone
      }
    }
    // Wait for graceful exit, with hard timeout.
    const exits = children.map((c) => c.exit)
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs)),
    ])
    for (const c of children) {
      if (c.proc.exitCode === null && c.proc.signalCode === null) {
        deps.log(`[pm-go] ${c.label} did not exit in ${gracePeriodMs}ms — SIGKILL`)
        try {
          c.proc.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }

  async function stop(reason: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    await tearDownChildren(reason)
  }

  async function shutdown(reason: string, exitCode = 130): Promise<never> {
    if (shuttingDown) {
      // Second signal — escalate immediately.
      deps.log(`[pm-go] second ${reason}; force-killing children`)
      for (const c of children) {
        try {
          c.proc.kill('SIGKILL')
        } catch {
          // process already gone — ignore
        }
      }
      // Mirror Bash's 130 for SIGINT, 143 for SIGTERM.
      process.exit(exitCode)
    }
    shuttingDown = true
    await tearDownChildren(reason)
    process.exit(exitCode)
  }

  deps.process.on('SIGINT', () => {
    void shutdown('SIGINT received', 130)
  })
  deps.process.on('SIGTERM', () => {
    void shutdown('SIGTERM received', 143)
  })

  return {
    add(child) {
      children.push(child)
    },
    shutdown,
    stop,
    get shuttingDown() {
      return shuttingDown
    },
  }
}
