/**
 * Spawn the Claude CLI process with configurable startup-timeout behaviour.
 *
 * The function resolves to the running `ChildProcess` as soon as the first
 * byte of stdout arrives. If no stdout arrives within `startupTimeoutMs`
 * the child is SIGKILL'd and a `ProcessStartupTimeoutError` is thrown.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ProcessStartupTimeoutError extends Error {
  override readonly name = "ProcessStartupTimeoutError";
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Claude process did not emit stdout within ${timeoutMs}ms startup window`,
    );
    this.timeoutMs = timeoutMs;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SpawnClaudeOptions {
  /** Working directory for the spawned process. */
  cwd?: string | undefined;
  /** Environment variables. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * Maximum milliseconds to wait for the first stdout byte before
   * SIGKILL-ing the child and throwing `ProcessStartupTimeoutError`.
   * Defaults to 30 000 ms.
   */
  startupTimeoutMs?: number | undefined;
  /**
   * Override the executable path. Defaults to `"claude"`.
   * Useful in unit tests where a mock binary (e.g. `sleep`) is substituted.
   */
  executablePath?: string | undefined;
}

// ---------------------------------------------------------------------------
// spawnClaude
// ---------------------------------------------------------------------------

/**
 * Spawn the Claude CLI (or a substitute binary) with `args`.
 *
 * Resolves to the running `ChildProcess` once the first stdout byte is
 * received. Rejects with `ProcessStartupTimeoutError` if no stdout
 * arrives within `startupTimeoutMs`.
 */
export function spawnClaude(
  args: string[],
  opts: SpawnClaudeOptions = {},
): Promise<ChildProcess> {
  const {
    cwd,
    env = process.env,
    startupTimeoutMs = 30_000,
    executablePath = "claude",
  } = opts;

  return new Promise<ChildProcess>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore kill errors */
      }
      reject(new ProcessStartupTimeoutError(startupTimeoutMs));
    }, startupTimeoutMs);

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // Resolve as soon as any stdout data arrives.
    child.stdout!.once("data", () => {
      settle(() => resolve(child));
    });

    // Propagate spawn errors (e.g. ENOENT if binary not found).
    child.once("error", (err: Error) => {
      settle(() => reject(err));
    });

    // If the process closes without producing stdout, treat it as a
    // startup failure (matches the timeout semantics for zero-output
    // processes).
    child.once("close", () => {
      settle(() => reject(new ProcessStartupTimeoutError(startupTimeoutMs)));
    });
  });
}
