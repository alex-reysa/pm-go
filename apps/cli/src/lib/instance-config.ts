/**
 * Per-instance configuration for `pm-go`.
 *
 * An "instance" is a logical name for a running pm-go control plane —
 * a port + a database URL + a default repo + a runtime mode. We
 * persist its config to `~/.pm-go/instances/<name>/config.json` so
 * later commands (`pm-go list`, `pm-go reattach`, `pm-go kill`) can
 * discover what's currently configured without grepping for stray
 * processes.
 *
 * Most users only ever use the implicit `"default"` instance — the
 * file gets created on the first `pm-go run` and silently re-read
 * on every subsequent invocation. Power users who want to run two
 * pm-go stacks against different repos at the same time pass
 * `--instance <name>` to keep them on disjoint ports + databases.
 *
 * This module is split into two halves:
 *
 *   1. Pure helpers — name validation, path-building, default merging,
 *      and a hand-rolled type-guard that's the on-disk-format gate.
 *      Zero I/O so the on-disk shape can be exercised exhaustively in
 *      unit tests.
 *
 *   2. Deps-injected I/O — `read`, `write`, and `list`. Every
 *      filesystem call goes through `InstanceConfigDeps` so tests can
 *      mock the disk and so the writer can be made atomic-ish (write
 *      to a tmp file, fs.rename onto the target).
 *
 * Slice 2 of the onboarding plan only owns this module — wiring it
 * into `run.ts` is a separate (parallel-conflict-prone) step.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuntimeMode = 'auto' | 'stub' | 'sdk' | 'claude'

export interface InstanceConfig {
  /** Logical name. CLI uses "default" when --instance is omitted. */
  name: string
  /** Absolute target repo path passed to --repo. */
  repoRoot: string
  /** Absolute monorepo root where pm-go binaries live. */
  monorepoRoot: string
  /** Wall-clock ISO when this instance was first created. */
  createdAt: string
  /** Wall-clock ISO when last `pm-go run` started against it. */
  lastStartedAt?: string
  /** Settings the supervisor reads on boot. */
  api: { port: number }
  database: { url: string }
  temporal: { taskQueue: string; address: string }
  /** Default runtime mode the user picked the first time. */
  runtime: RuntimeMode
  /** Optional artifact dir overrides, absolute. */
  artifactDir?: string
  runnerDiagnosticDir?: string
  worktreeRoot?: string
  integrationWorktreeRoot?: string
}

export interface InstanceConfigDeps {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  mkdir: (path: string, opts: { recursive?: boolean }) => Promise<void>
  fileExists: (path: string) => Promise<boolean>
  /** Atomic rename — used to commit the tmp file onto the real path. */
  rename: (a: string, b: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Constants + name validation
// ---------------------------------------------------------------------------

const DEFAULT_INSTANCE_NAME = 'default'
const MAX_NAME_LEN = 64

const RUNTIME_VALUES: readonly RuntimeMode[] = ['auto', 'stub', 'sdk', 'claude']

const DEFAULT_API_PORT = 3001
const DEFAULT_DATABASE_URL = 'postgres://pmgo:pmgo@localhost:5432/pm_go'
const DEFAULT_TEMPORAL_ADDRESS = 'localhost:7233'
const DEFAULT_TEMPORAL_TASK_QUEUE = 'pm-go'
const DEFAULT_RUNTIME: RuntimeMode = 'auto'

/** The implicit instance name used when `--instance` is omitted. */
export function defaultInstanceName(): string {
  return DEFAULT_INSTANCE_NAME
}

/**
 * Reject names that would escape the instances dir or otherwise be
 * surprising on disk. Centralised so both `instanceConfigPath` and
 * `listInstances` (which has to parse names back from the directory
 * scan) agree on what counts as valid.
 */
function assertValidInstanceName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('instance name must be a non-empty string')
  }
  if (name.length > MAX_NAME_LEN) {
    throw new Error(
      `instance name too long (${name.length} > ${MAX_NAME_LEN}): ${name.slice(0, MAX_NAME_LEN)}…`,
    )
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`instance name may not contain '/' or '\\\\': ${name}`)
  }
  if (name.includes('..')) {
    throw new Error(`instance name may not contain '..': ${name}`)
  }
  if (name.startsWith('.')) {
    throw new Error(`instance name may not start with '.': ${name}`)
  }
  // NUL bytes break path APIs on some platforms; bail explicitly.
  if (name.includes('\u0000')) {
    throw new Error(`instance name may not contain NUL bytes`)
  }
}

/**
 * Build the path `<homeDir>/.pm-go/instances/<name>/config.json`.
 * Pure: no I/O, no cwd lookup. The `homeDir` is injected so tests
 * can use a tmp dir and so a future `--config-home` flag can override
 * it from the CLI.
 *
 * Throws on invalid names so callers don't accidentally write to
 * `~/.pm-go/instances/../../etc/passwd/config.json`.
 */
export function instanceConfigPath(name: string, homeDir: string): string {
  assertValidInstanceName(name)
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    throw new Error('homeDir must be a non-empty string')
  }
  // Strip a single trailing slash so we don't produce `//`.
  const trimmedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir
  return `${trimmedHome}/.pm-go/instances/${name}/config.json`
}

/** Directory containing a single instance's config + future state. */
function instanceDir(name: string, homeDir: string): string {
  const cfg = instanceConfigPath(name, homeDir)
  return cfg.slice(0, -'/config.json'.length)
}

/** Root dir that holds every instance subdir. */
function instancesRoot(homeDir: string): string {
  const trimmedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir
  return `${trimmedHome}/.pm-go/instances`
}

// ---------------------------------------------------------------------------
// Defaults + merge
// ---------------------------------------------------------------------------

/**
 * Merge `defaults <- existing <- updates`, prefer-last semantics.
 * Each call sets `name` from the most-derived source so a caller
 * passing `{ name: "scratch" }` in `updates` always wins.
 *
 * Throws if a required scalar (name, repoRoot, monorepoRoot,
 * createdAt) is still missing after the merge — those have no sane
 * default and silently emitting a config with `repoRoot: ""` would
 * just shift the failure into the supervisor. `validateInstanceConfig`
 * also rejects them, but throwing here lets callers distinguish
 * "user error: forgot a flag" from "on-disk corruption".
 *
 * Sub-objects (`api`, `database`, `temporal`) are merged shallowly so
 * a caller can update just `api.port` without re-specifying
 * `database.url`.
 */
export function mergeInstanceConfig(
  existing: Partial<InstanceConfig> | null,
  updates: Partial<InstanceConfig>,
): InstanceConfig {
  const e: Partial<InstanceConfig> = existing ?? {}
  const u = updates

  const name = u.name ?? e.name ?? DEFAULT_INSTANCE_NAME
  const repoRoot = u.repoRoot ?? e.repoRoot
  const monorepoRoot = u.monorepoRoot ?? e.monorepoRoot
  const createdAt = u.createdAt ?? e.createdAt

  // Validate required scalars before constructing the typed result.
  // Empty strings count as missing — an empty repoRoot would resolve
  // to "" and silently break the supervisor's path checks downstream.
  const missing: string[] = []
  if (!isNonEmptyString(name)) missing.push('name')
  if (!isNonEmptyString(repoRoot)) missing.push('repoRoot')
  if (!isNonEmptyString(monorepoRoot)) missing.push('monorepoRoot')
  if (!isNonEmptyString(createdAt)) missing.push('createdAt')
  if (missing.length > 0) {
    throw new Error(
      `mergeInstanceConfig: missing required field(s): ${missing.join(', ')}`,
    )
  }

  // Re-validate the name now that it might have come from
  // existing state — a corrupt on-disk file should not let `..` slip
  // through into a downstream rename target.
  assertValidInstanceName(name)

  const merged: InstanceConfig = {
    name,
    repoRoot: repoRoot as string,
    monorepoRoot: monorepoRoot as string,
    createdAt: createdAt as string,
    api: {
      port: u.api?.port ?? e.api?.port ?? DEFAULT_API_PORT,
    },
    database: {
      url: u.database?.url ?? e.database?.url ?? DEFAULT_DATABASE_URL,
    },
    temporal: {
      taskQueue:
        u.temporal?.taskQueue ?? e.temporal?.taskQueue ?? DEFAULT_TEMPORAL_TASK_QUEUE,
      address:
        u.temporal?.address ?? e.temporal?.address ?? DEFAULT_TEMPORAL_ADDRESS,
    },
    runtime: u.runtime ?? e.runtime ?? DEFAULT_RUNTIME,
  }

  // Optional fields: only set when one of the layers actually had a
  // value. With exactOptionalPropertyTypes, assigning `undefined`
  // would itself be a type error, so we only assign when defined.
  const lastStartedAt = u.lastStartedAt ?? e.lastStartedAt
  if (lastStartedAt !== undefined) merged.lastStartedAt = lastStartedAt
  const artifactDir = u.artifactDir ?? e.artifactDir
  if (artifactDir !== undefined) merged.artifactDir = artifactDir
  const runnerDiagnosticDir = u.runnerDiagnosticDir ?? e.runnerDiagnosticDir
  if (runnerDiagnosticDir !== undefined) merged.runnerDiagnosticDir = runnerDiagnosticDir
  const worktreeRoot = u.worktreeRoot ?? e.worktreeRoot
  if (worktreeRoot !== undefined) merged.worktreeRoot = worktreeRoot
  const integrationWorktreeRoot = u.integrationWorktreeRoot ?? e.integrationWorktreeRoot
  if (integrationWorktreeRoot !== undefined) {
    merged.integrationWorktreeRoot = integrationWorktreeRoot
  }

  return merged
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

// ---------------------------------------------------------------------------
// Runtime validation (the on-disk-format guard)
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; config: InstanceConfig }
  | { ok: false; errors: string[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[],
  required = true,
): string | undefined {
  const v = obj[key]
  if (v === undefined) {
    if (required) errors.push(`missing required string field: ${key}`)
    return undefined
  }
  if (typeof v !== 'string') {
    errors.push(`field ${key} must be a string, got ${typeof v}`)
    return undefined
  }
  if (required && v.length === 0) {
    errors.push(`field ${key} must be a non-empty string`)
    return undefined
  }
  return v
}

function checkNestedString(
  parent: Record<string, unknown> | undefined,
  parentName: string,
  key: string,
  errors: string[],
): string | undefined {
  if (parent === undefined) {
    errors.push(`missing required object field: ${parentName}`)
    return undefined
  }
  const v = parent[key]
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(`field ${parentName}.${key} must be a non-empty string`)
    return undefined
  }
  return v
}

/**
 * Validate a parsed-from-JSON value against the InstanceConfig
 * shape. Returns a tagged union so callers can render every error
 * at once instead of failing on the first issue (which is a much
 * worse experience when a user has a typo in their config).
 *
 * This is the on-disk-format gate. Anything `readInstanceConfig`
 * rejects here will throw rather than silently coerce.
 */
export function validateInstanceConfig(value: unknown): ValidationResult {
  const errors: string[] = []

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['config must be a JSON object'] }
  }

  const name = checkString(value, 'name', errors)
  if (name !== undefined) {
    try {
      assertValidInstanceName(name)
    } catch (e) {
      errors.push(`field name: ${(e as Error).message}`)
    }
  }
  const repoRoot = checkString(value, 'repoRoot', errors)
  const monorepoRoot = checkString(value, 'monorepoRoot', errors)
  const createdAt = checkString(value, 'createdAt', errors)
  const lastStartedAt = checkString(value, 'lastStartedAt', errors, false)

  const api = isPlainObject(value.api) ? value.api : undefined
  if (api === undefined) {
    errors.push('missing required object field: api')
  } else {
    const port = api.port
    if (
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      errors.push('field api.port must be an integer 1..65535')
    }
  }

  const database = isPlainObject(value.database) ? value.database : undefined
  checkNestedString(database, 'database', 'url', errors)

  const temporal = isPlainObject(value.temporal) ? value.temporal : undefined
  checkNestedString(temporal, 'temporal', 'taskQueue', errors)
  checkNestedString(temporal, 'temporal', 'address', errors)

  const runtimeRaw = value.runtime
  let runtime: RuntimeMode | undefined
  if (typeof runtimeRaw !== 'string') {
    errors.push('field runtime must be one of auto|stub|sdk|claude')
  } else if (!RUNTIME_VALUES.includes(runtimeRaw as RuntimeMode)) {
    errors.push(
      `field runtime must be one of ${RUNTIME_VALUES.join('|')}, got ${runtimeRaw}`,
    )
  } else {
    runtime = runtimeRaw as RuntimeMode
  }

  const artifactDir = checkString(value, 'artifactDir', errors, false)
  const runnerDiagnosticDir = checkString(
    value,
    'runnerDiagnosticDir',
    errors,
    false,
  )
  const worktreeRoot = checkString(value, 'worktreeRoot', errors, false)
  const integrationWorktreeRoot = checkString(
    value,
    'integrationWorktreeRoot',
    errors,
    false,
  )

  if (errors.length > 0) return { ok: false, errors }

  // Safe to assert: every required field passed the checks above.
  const config: InstanceConfig = {
    name: name as string,
    repoRoot: repoRoot as string,
    monorepoRoot: monorepoRoot as string,
    createdAt: createdAt as string,
    api: { port: (api as Record<string, unknown>).port as number },
    database: { url: (database as Record<string, unknown>).url as string },
    temporal: {
      taskQueue: (temporal as Record<string, unknown>).taskQueue as string,
      address: (temporal as Record<string, unknown>).address as string,
    },
    runtime: runtime as RuntimeMode,
  }
  if (lastStartedAt !== undefined) config.lastStartedAt = lastStartedAt
  if (artifactDir !== undefined) config.artifactDir = artifactDir
  if (runnerDiagnosticDir !== undefined) config.runnerDiagnosticDir = runnerDiagnosticDir
  if (worktreeRoot !== undefined) config.worktreeRoot = worktreeRoot
  if (integrationWorktreeRoot !== undefined) {
    config.integrationWorktreeRoot = integrationWorktreeRoot
  }
  return { ok: true, config }
}

// ---------------------------------------------------------------------------
// I/O — read, write, list
// ---------------------------------------------------------------------------

/**
 * Read `<homeDir>/.pm-go/instances/<name>/config.json`. Returns null
 * when the file is absent (so callers can treat "first run" as a
 * non-error case). Throws on JSON parse errors or schema mismatch —
 * silently coercing a corrupt file would propagate bad state into
 * future writes.
 */
export async function readInstanceConfig(
  name: string,
  homeDir: string,
  deps: InstanceConfigDeps,
): Promise<InstanceConfig | null> {
  const path = instanceConfigPath(name, homeDir)
  if (!(await deps.fileExists(path))) return null
  const raw = await deps.readFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `instance config at ${path} is not valid JSON: ${(err as Error).message}`,
    )
  }
  const result = validateInstanceConfig(parsed)
  if (!result.ok) {
    throw new Error(
      `instance config at ${path} failed validation:\n  - ${result.errors.join('\n  - ')}`,
    )
  }
  return result.config
}

/**
 * Persist a config to disk atomic-ish: create the parent directory
 * if needed, write to `<path>.tmp`, then `rename` onto the target.
 * Rename is atomic on POSIX within the same filesystem, which is
 * exactly the case here (everything stays under `~/.pm-go`). This
 * keeps the file from being readable in a half-written state if the
 * writer crashes mid-call.
 *
 * The config is re-validated before writing so a caller that
 * hand-built it (vs. running through `mergeInstanceConfig`) can't
 * silently emit a corrupt file.
 */
export async function writeInstanceConfig(
  config: InstanceConfig,
  homeDir: string,
  deps: InstanceConfigDeps,
): Promise<void> {
  const result = validateInstanceConfig(config)
  if (!result.ok) {
    throw new Error(
      `writeInstanceConfig: refusing to write invalid config:\n  - ${result.errors.join('\n  - ')}`,
    )
  }
  const dir = instanceDir(config.name, homeDir)
  const path = instanceConfigPath(config.name, homeDir)
  const tmp = `${path}.tmp`

  await deps.mkdir(dir, { recursive: true })
  // JSON.stringify with `2`-space indent keeps the file diffable —
  // users will eyeball it more than they'll edit it, but we leave
  // them the option.
  const body = `${JSON.stringify(result.config, null, 2)}\n`
  await deps.writeFile(tmp, body)
  await deps.rename(tmp, path)
}

/**
 * Scan `<homeDir>/.pm-go/instances/` and return the names of the
 * instances whose `config.json` parses + validates successfully.
 * Names that fail validation are silently dropped — they'd show up
 * as garbled rows in `pm-go list` otherwise, which is worse than
 * just hiding them.
 *
 * `readdir` is on its own member rather than added to the base
 * `InstanceConfigDeps` because `read` and `write` don't need it; this
 * lets callers that don't list keep their dep surface small.
 */
export async function listInstances(
  homeDir: string,
  deps: InstanceConfigDeps & {
    readdir: (path: string) => Promise<string[]>
  },
): Promise<string[]> {
  const root = instancesRoot(homeDir)
  if (!(await deps.fileExists(root))) return []
  let entries: string[]
  try {
    entries = await deps.readdir(root)
  } catch {
    // A non-directory at that path (e.g. someone left a file there)
    // shouldn't crash a list-style command — return empty and let
    // the writer be the one to surface the error on its next call.
    return []
  }

  const valid: string[] = []
  for (const name of entries) {
    // Skip names that would fail our path-builder anyway, including
    // `.` / `..` and dotfiles that shells leave around.
    try {
      assertValidInstanceName(name)
    } catch {
      continue
    }
    const cfg = await readInstanceConfig(name, homeDir, deps).catch(() => null)
    if (cfg !== null) valid.push(cfg.name)
  }
  // Stable sort so consumers don't have to depend on filesystem
  // iteration order (which on macOS is HFS-dependent).
  valid.sort()
  return valid
}
