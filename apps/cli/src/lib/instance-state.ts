/**
 * Per-instance *runtime* state for `pm-go`.
 *
 * Where `instance-config.ts` owns the long-lived "what does instance
 * X look like" record (ports, repo, runtime mode), this module owns
 * the ephemeral "is instance X currently running, and where" record:
 * the supervisor PID, the api port it bound, the wall-clock start
 * time. Phase-1 commands like `pm-go list`, `pm-go reattach`, and
 * `pm-go kill` consume it to find live processes without grepping ps.
 *
 * State files live at `<homeDir>/.pm-go/state/<apiPort>.json`. The
 * filename is keyed on the api port — not the instance name — so two
 * processes that fight for the same port can't both claim "I'm
 * running" without overwriting each other's record. The state dir
 * itself is created with mode 0700 because the records contain PIDs
 * and ports a coexisting user on the box has no business reading.
 *
 * Like `instance-config.ts`, this module is split:
 *
 *   1. Pure helpers — name validation (delegated by relying on the
 *      same path-shape rules), path-building, the on-disk-format
 *      runtime guard. Zero I/O.
 *
 *   2. Deps-injected I/O — `read`, `write`, `list`, `remove`. Every
 *      filesystem call goes through `InstanceStateDeps` so tests can
 *      mock the disk and so the writer is atomic-ish (write to a tmp
 *      file, fs.rename onto the target).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstanceState {
  /** Logical instance name. CLI uses "default" when --instance is omitted. */
  instanceName: string
  /**
   * The port the supervisor bound for the API. Doubles as the
   * filename key on disk — two state files cannot share a port.
   */
  apiPort: number
  /** PID of the supervisor process owning the api + worker children. */
  pid: number
  /** ISO timestamp when the supervisor started. */
  startedAt: string
  /**
   * PIDs of every tracked child process — api, worker, etc — that
   * the supervisor brought up. Consumed by `port-preflight` so a
   * pre-flight check on a port held by one of our own children does
   * not raise a false-positive conflict.
   */
  childPids?: number[]
}

export interface InstanceStateDeps {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  /**
   * Mode is forwarded as `0o700` for the state dir. Tests should
   * record the mode they were called with so the 0700-creation
   * assertion has a fixture to inspect.
   */
  mkdir: (path: string, opts: { recursive?: boolean; mode?: number }) => Promise<void>
  fileExists: (path: string) => Promise<boolean>
  /** Atomic rename — used to commit the tmp file onto the real path. */
  rename: (a: string, b: string) => Promise<void>
  /** Used by `removeInstanceState`. */
  unlink: (path: string) => Promise<void>
  /** Used by `listInstanceStates`. */
  readdir: (path: string) => Promise<string[]>
}

// ---------------------------------------------------------------------------
// Constants + path building
// ---------------------------------------------------------------------------

/** Mode for the state directory: rwx for owner only. */
export const STATE_DIR_MODE = 0o700

const MIN_PORT = 1
const MAX_PORT = 65535

function trimTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p
}

function assertValidApiPort(apiPort: number): void {
  if (
    typeof apiPort !== 'number' ||
    !Number.isInteger(apiPort) ||
    apiPort < MIN_PORT ||
    apiPort > MAX_PORT
  ) {
    throw new Error(
      `apiPort must be an integer in [${MIN_PORT}, ${MAX_PORT}], got ${String(apiPort)}`,
    )
  }
}

function assertValidHomeDir(homeDir: string): void {
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    throw new Error('homeDir must be a non-empty string')
  }
}

/** Directory that holds every state-<apiPort>.json file. */
export function instanceStateDir(homeDir: string): string {
  assertValidHomeDir(homeDir)
  return `${trimTrailingSlash(homeDir)}/.pm-go/state`
}

/**
 * Build the path `<homeDir>/.pm-go/state/<apiPort>.json`. Pure: no
 * I/O. Throws on invalid apiPort or homeDir so callers don't
 * accidentally write to `~/.pm-go/state/-1.json` or similar.
 */
export function instanceStatePath(apiPort: number, homeDir: string): string {
  assertValidApiPort(apiPort)
  return `${instanceStateDir(homeDir)}/${apiPort}.json`
}

/**
 * Inverse of `instanceStatePath`: parse `<n>.json` back into a
 * port number, or return `null` if the filename does not match the
 * expected shape. Used by `listInstanceStates` to ignore strays
 * (`.DS_Store`, editor swap files, etc) that may end up in the dir.
 */
export function parseStateFilename(filename: string): number | null {
  if (!filename.endsWith('.json')) return null
  const stem = filename.slice(0, -'.json'.length)
  // Reject leading zeros / signs / decimals — only `[1-9][0-9]*`.
  // Catches `03001.json` and similar editor backups that happen to
  // numerically resolve to a real port.
  if (!/^[1-9][0-9]*$/.test(stem)) return null
  const n = Number(stem)
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) return null
  return n
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export type StateValidationResult =
  | { ok: true; state: InstanceState }
  | { ok: false; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

/**
 * Validate a parsed-from-JSON value against the InstanceState
 * shape. Returns a tagged union so callers can render every error
 * at once instead of failing on the first issue.
 */
export function validateInstanceState(value: unknown): StateValidationResult {
  const errors: string[] = []

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['state must be a JSON object'] }
  }

  const instanceName = value.instanceName
  if (typeof instanceName !== 'string' || instanceName.length === 0) {
    errors.push('field instanceName must be a non-empty string')
  }

  const apiPort = value.apiPort
  if (
    typeof apiPort !== 'number' ||
    !Number.isInteger(apiPort) ||
    apiPort < MIN_PORT ||
    apiPort > MAX_PORT
  ) {
    errors.push(`field apiPort must be an integer in [${MIN_PORT}, ${MAX_PORT}]`)
  }

  if (!isPositiveInt(value.pid)) {
    errors.push('field pid must be a positive integer')
  }

  const startedAt = value.startedAt
  if (typeof startedAt !== 'string' || startedAt.length === 0) {
    errors.push('field startedAt must be a non-empty string')
  }

  let childPids: number[] | undefined
  if (value.childPids !== undefined) {
    if (!Array.isArray(value.childPids)) {
      errors.push('field childPids must be an array of positive integers')
    } else {
      const arr: number[] = []
      for (let i = 0; i < value.childPids.length; i++) {
        const p = value.childPids[i]
        if (!isPositiveInt(p)) {
          errors.push(`field childPids[${i}] must be a positive integer`)
        } else {
          arr.push(p)
        }
      }
      childPids = arr
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const state: InstanceState = {
    instanceName: instanceName as string,
    apiPort: apiPort as number,
    pid: value.pid as number,
    startedAt: startedAt as string,
  }
  if (childPids !== undefined) state.childPids = childPids
  return { ok: true, state }
}

// ---------------------------------------------------------------------------
// I/O — read, write, list, remove
// ---------------------------------------------------------------------------

/**
 * Read `<homeDir>/.pm-go/state/<apiPort>.json`. Returns `null` when
 * the file is absent (so callers can treat "no live record" as a
 * non-error case — the supervisor may simply not be running). Throws
 * on JSON parse errors or schema mismatch — silently coercing a
 * corrupt file would propagate bad state into future writes.
 */
export async function readInstanceState(
  apiPort: number,
  homeDir: string,
  deps: InstanceStateDeps,
): Promise<InstanceState | null> {
  const path = instanceStatePath(apiPort, homeDir)
  if (!(await deps.fileExists(path))) return null
  const raw = await deps.readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `instance state at ${path} is not valid JSON: ${(err as Error).message}`,
    )
  }
  const result = validateInstanceState(parsed)
  if (!result.ok) {
    throw new Error(
      `instance state at ${path} failed validation:\n  - ${result.errors.join('\n  - ')}`,
    )
  }
  return result.state
}

/**
 * Persist a state record atomic-ish: create the parent dir (mode
 * 0700) if needed, write to `<path>.tmp`, then `rename` onto the
 * target. Rename is atomic on POSIX within the same filesystem,
 * which is exactly the case here (everything stays under `~/.pm-go`).
 * This keeps the file from being readable in a half-written state if
 * the writer crashes mid-call.
 *
 * The state is re-validated before writing so a caller that
 * hand-built it can't silently emit a corrupt record.
 */
export async function writeInstanceState(
  state: InstanceState,
  homeDir: string,
  deps: InstanceStateDeps,
): Promise<void> {
  const result = validateInstanceState(state)
  if (!result.ok) {
    throw new Error(
      `writeInstanceState: refusing to write invalid state:\n  - ${result.errors.join('\n  - ')}`,
    )
  }
  const dir = instanceStateDir(homeDir)
  const path = instanceStatePath(state.apiPort, homeDir)
  const tmp = `${path}.tmp`

  // mode 0700: state contains PIDs / ports we don't want a coexisting
  // user on the box snooping at.
  await deps.mkdir(dir, { recursive: true, mode: STATE_DIR_MODE })
  // 2-space indent keeps the file diffable when an operator eyeballs
  // it during incident triage.
  const body = `${JSON.stringify(result.state, null, 2)}\n`
  await deps.writeFile(tmp, body)
  await deps.rename(tmp, path)
}

/**
 * Delete `<homeDir>/.pm-go/state/<apiPort>.json`. No-op if the file
 * is already gone — the caller's intent is "make sure this record is
 * not on disk", and a missing file already satisfies that.
 */
export async function removeInstanceState(
  apiPort: number,
  homeDir: string,
  deps: InstanceStateDeps,
): Promise<void> {
  const path = instanceStatePath(apiPort, homeDir)
  if (!(await deps.fileExists(path))) return
  await deps.unlink(path)
}

/**
 * Scan `<homeDir>/.pm-go/state/` and return every state record whose
 * `<port>.json` file parses + validates successfully. Filenames that
 * don't match `<port>.json` (`.DS_Store`, editor backups) and files
 * that fail validation are silently dropped — they'd show up as
 * garbled rows in `pm-go list` otherwise, which is worse than just
 * hiding them.
 *
 * Results are sorted by apiPort so consumers don't have to depend on
 * filesystem iteration order (which on macOS is HFS-dependent).
 */
export async function listInstanceStates(
  homeDir: string,
  deps: InstanceStateDeps,
): Promise<InstanceState[]> {
  const dir = instanceStateDir(homeDir)
  if (!(await deps.fileExists(dir))) return []
  let entries: string[]
  try {
    entries = await deps.readdir(dir)
  } catch {
    // A non-directory at that path shouldn't crash a list-style
    // command — return empty and let the writer be the one to
    // surface the error on its next call.
    return []
  }

  const ports: number[] = []
  for (const name of entries) {
    const p = parseStateFilename(name)
    if (p !== null) ports.push(p)
  }
  ports.sort((a, b) => a - b)

  const out: InstanceState[] = []
  for (const port of ports) {
    const state = await readInstanceState(port, homeDir, deps).catch(() => null)
    if (state !== null) out.push(state)
  }
  return out
}
