#!/usr/bin/env node
/**
 * pm-go CLI entrypoint.
 *
 * Subcommands:
 *   pm-go run [options]      Bring up the local stack, optionally submit a spec,
 *                              and stay attached. Replaces the three-terminal flow.
 *   pm-go drive [options]    Drive a submitted plan to released by sequencing
 *                              API calls (run/review/fix/integrate/audit/release).
 *   pm-go doctor [options]   Probe API keys / local CLIs / runtime / infra; can
 *                              auto-repair fixable problems with --repair.
 *   pm-go ps [options]       List supervisor / worker / api / drive pids the
 *                              current pm-go install owns.
 *   pm-go stop [options]     Send SIGTERM (then SIGKILL after --grace-ms) to
 *                              every process listed in the state file.
 *   pm-go recover [options]  Sweep the state file: drop entries whose pid is
 *                              no longer alive so a fresh `pm-go run` can boot.
 *
 * Examples:
 *   pm-go run                                       # boot the stack only
 *   pm-go run --spec ./examples/golden-path/spec.md # boot + submit spec
 *   pm-go drive --plan <uuid>                       # drive plan to released
 *   pm-go doctor                                    # diagnostics
 *   pm-go doctor --repair                           # diagnose + auto-fix
 *   pm-go ps                                        # show pm-go-owned processes
 *   pm-go stop --grace-ms 8000                      # graceful shutdown
 *   pm-go recover                                   # clear stale state entries
 */

import { spawn as nodeSpawn, execFile as execFileCb } from 'node:child_process'
import { access, constants, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { detectAvailableRuntimes } from '@pm-go/runtime-detector'

import {
  runDoctor,
  type InfraProbeDeps,
  type RepairDeps,
} from './doctor.js'
import {
  driveCli,
  DRIVE_USAGE,
  type DriveCliDeps,
  type DriveDeps,
} from './drive.js'
import {
  implementCli,
  IMPLEMENT_USAGE,
  type ImplementCliDeps,
} from './implement.js'
import { applyDotenv } from './lib/dotenv.js'
import {
  runCli,
  RUN_USAGE,
  type InstanceStateEntry,
  type PortConflict,
  type PortPreflightResult,
  type RunCliDeps,
  type RunDeps,
} from './run.js'
import { runStatus, STATUS_USAGE } from './status.js'

const execFile = promisify(execFileCb)

const ROOT_USAGE = `Usage: pm-go <command> [options]

Commands:
  implement   Boot stack + submit spec + drive to release in one command.
  run         Start the pm-go control plane (supervisor only).
  drive       Drive a submitted plan to released against a running stack.
  status      Show worker config, API health, and open Temporal workflows.
  doctor      Probe runtimes + diagnose configuration. Use --repair to fix.
  ps          List supervisor / worker / api / drive pids pm-go owns.
  stop        Stop every pm-go-owned process (SIGTERM then SIGKILL).
  recover     Drop dead entries from the state file.

Run \`pm-go <command> --help\` for command-specific options.

Quickest path:
  pm-go implement --repo . --spec ./feature.md`

const PS_USAGE = `Usage: pm-go ps [options]

List the supervisor / worker / api / drive pids the current pm-go install
recorded in its per-instance state file. Empty output means no pm-go process
is running (or the state file was cleared).

Options:
  -h, --help  Show this message.`

const STOP_USAGE = `Usage: pm-go stop [options]

Send SIGTERM (then SIGKILL after --grace-ms) to every process listed in the
pm-go state file, then remove the file. Idempotent: a missing or empty state
file exits 0.

Options:
  --grace-ms <n>  Time to wait for SIGTERM before SIGKILL (default 5000).
  -h, --help      Show this message.`

const RECOVER_USAGE = `Usage: pm-go recover [options]

Sweep the state file and drop entries whose pid is no longer alive so a
fresh \`pm-go run\` can boot without colliding on the registry. Reports the
remaining live entries.

Options:
  -h, --help  Show this message.`

const DOCTOR_USAGE = `Usage: pm-go doctor [options]

Probe API keys, local CLIs, runtime resolution, and infrastructure
(docker / postgres / temporal / migrations / writable dirs / API port).

Options:
  --repair    Attempt to fix what's auto-fixable (create missing dirs,
              run \`docker compose up -d\`, run \`pnpm db:migrate\`),
              then re-probe.
  --verbose   Print extra diagnostic detail on failure.
  -h, --help  Show this message.`

const [, , subcommand, ...rest] = process.argv

async function main(): Promise<number> {
  switch (subcommand) {
    case 'doctor': {
      if (rest.includes('--help') || rest.includes('-h')) {
        console.log(DOCTOR_USAGE)
        return 0
      }
      const repair = rest.includes('--repair')
      const verbose = rest.includes('--verbose')
      const monorepoRoot = resolveMonorepoRoot()
      // Load .env before probing so doctor sees the same env vars
      // that `run` / `implement` will see at boot. Without this,
      // doctor reported keys as missing even though .env defined
      // them, which sent operators down false paths.
      await applyDotenv(path.join(monorepoRoot, '.env'), {
        readFile: (p) => readFile(p, 'utf8'),
        fileExists: async (p) => {
          try {
            await access(p)
            return true
          } catch {
            return false
          }
        },
        env: process.env,
        log: (l) => console.warn(l),
      })
      const productionExec = async (
        cmd: string,
        args: readonly string[],
      ): Promise<{ code: number; stdout: string; stderr: string }> => {
        try {
          const { stdout, stderr } = await execFile(cmd, [...args], {
            cwd: monorepoRoot,
            maxBuffer: 16 * 1024 * 1024,
          })
          return { code: 0, stdout, stderr }
        } catch (err) {
          const e = err as NodeJS.ErrnoException & {
            code?: number | string
            stdout?: string
            stderr?: string
          }
          if (typeof e.code === 'string' && e.code === 'ENOENT') {
            // Re-throw so probes can detect "command not found" cleanly.
            throw err
          }
          const numericCode =
            typeof e.code === 'number' ? e.code : 1
          return {
            code: numericCode,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? e.message ?? '',
          }
        }
      }
      const fileExists = async (p: string) => {
        try {
          await access(p)
          return true
        } catch {
          return false
        }
      }
      const isWritable = async (p: string) => {
        try {
          await access(p, constants.W_OK)
          return true
        } catch {
          return false
        }
      }
      const infra: InfraProbeDeps = {
        exec: productionExec,
        env: process.env,
        fileExists,
        isWritable,
        monorepoRoot,
      }
      const repairDeps: RepairDeps = {
        ...infra,
        mkdir: async (p, opts) => {
          await mkdir(p, opts)
        },
        log: (l) => console.log(l),
      }
      // Probe for a Claude Code OAuth session — same signal the
      // worker uses inside `hasSdkAccess()`. Doctor and worker stay
      // aligned: if the worker would happily pick `anthropic-sdk`,
      // doctor reports it instead of falsely flagging the SDK key
      // as missing.
      const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
      const oauthPath = home ? path.join(home, '.claude', '.credentials.json') : ''
      const hasOAuth = oauthPath
        ? async () => {
            try {
              await access(oauthPath)
              return true
            } catch {
              return false
            }
          }
        : undefined
      return runDoctor({
        detectRuntimes: detectAvailableRuntimes,
        env: process.env,
        write: console.log,
        infra,
        repairDeps,
        repair,
        verbose,
        ...(hasOAuth ? { hasOAuth } : {}),
      })
    }

    case 'run': {
      // Forward `pm-go run --help` to the run subcommand's own usage block.
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(RUN_USAGE)
        return 0
      }
      // pnpm/npm set INIT_CWD to the directory the user actually invoked
      // the command from. `process.cwd()` here is misleading because
      // `pnpm --filter @pm-go/cli exec` switches into apps/cli before
      // running this entry-point. Prefer INIT_CWD when present so
      // `pm-go run --repo .` means "the repo I typed this from."
      const userCwd = process.env.INIT_CWD ?? process.cwd()
      const cliDeps: RunCliDeps = {
        argv: rest,
        cwd: userCwd,
        monorepoRoot: resolveMonorepoRoot(),
        log: (l) => console.log(l),
        errLog: (l) => console.error(l),
        resolve: (base, p) => (path.isAbsolute(p) ? p : path.resolve(base, p)),
        buildSupervisorDeps: () => buildProductionSupervisorDeps(),
        // Wire the same state-file path the supervisor writes to so
        // SIGINT / a clean stop deletes it atomically.
        removeInstanceState: () =>
          productionRemoveInstanceState(defaultStateFilePath()),
        // Read .env from the monorepo root and apply any unset keys
        // to process.env. Pre-existing shell exports always win.
        applyDotenv: (p) =>
          applyDotenv(p, {
            readFile: (path) => readFile(path, 'utf8'),
            fileExists: async (path) => {
              try {
                await access(path)
                return true
              } catch {
                return false
              }
            },
            env: process.env,
            log: (l) => console.warn(l),
          }),
      }
      return runCli(cliDeps)
    }

    case 'drive': {
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(DRIVE_USAGE)
        return 0
      }
      const driveCliDeps: DriveCliDeps = {
        argv: rest,
        log: (l) => console.log(l),
        errLog: (l) => console.error(l),
        buildDriveDeps: () => buildProductionDriveDeps(),
      }
      return driveCli(driveCliDeps)
    }

    case 'status': {
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(STATUS_USAGE)
        return 0
      }
      const monorepoRoot = resolveMonorepoRoot()
      // Mirror the doctor case: load .env so status reflects the same
      // env the supervisor would see at boot.
      await applyDotenv(path.join(monorepoRoot, '.env'), {
        readFile: (p) => readFile(p, 'utf8'),
        fileExists: async (p) => {
          try {
            await access(p)
            return true
          } catch {
            return false
          }
        },
        env: process.env,
        log: (l) => console.warn(l),
      })
      const statusExec = async (
        cmd: string,
        args: readonly string[],
      ): Promise<{ code: number; stdout: string; stderr: string }> => {
        try {
          const { stdout, stderr } = await execFile(cmd, [...args], {
            cwd: monorepoRoot,
            maxBuffer: 16 * 1024 * 1024,
          })
          return { code: 0, stdout, stderr }
        } catch (err) {
          const e = err as NodeJS.ErrnoException & {
            code?: number | string
            stdout?: string
            stderr?: string
          }
          const numericCode = typeof e.code === 'number' ? e.code : 1
          return {
            code: numericCode,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? e.message ?? '',
          }
        }
      }
      return runStatus({
        exec: statusExec,
        env: process.env,
        fetch: globalThis.fetch.bind(globalThis),
        write: console.log,
        monorepoRoot,
      })
    }

    case 'implement': {
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(IMPLEMENT_USAGE)
        return 0
      }
      const userCwd = process.env.INIT_CWD ?? process.cwd()
      const implementCliDeps: ImplementCliDeps = {
        argv: rest,
        cwd: userCwd,
        monorepoRoot: resolveMonorepoRoot(),
        log: (l) => console.log(l),
        errLog: (l) => console.error(l),
        resolve: (base, p) => (path.isAbsolute(p) ? p : path.resolve(base, p)),
        buildSupervisorDeps: () => buildProductionSupervisorDeps(),
        buildDriveDeps: () => buildProductionDriveDeps(),
        removeInstanceState: () =>
          productionRemoveInstanceState(defaultStateFilePath()),
        applyDotenv: (p) =>
          applyDotenv(p, {
            readFile: (path) => readFile(path, 'utf8'),
            fileExists: async (path) => {
              try {
                await access(path)
                return true
              } catch {
                return false
              }
            },
            env: process.env,
            log: (l) => console.warn(l),
          }),
      }
      return implementCli(implementCliDeps)
    }

    case 'ps': {
      // T1a's `ps` slice will eventually live in `./ps.js`; until it
      // does, the registration handles --help / unknown-flag rejection
      // here and prints the entries inline. Behavior matches the
      // existing subcommand convention (--help wins; unknown flag
      // exits 1 with usage).
      const psParse = parseFlagsOnly(rest, [])
      if (!psParse.ok) {
        if (psParse.error === 'help') {
          console.log(PS_USAGE)
          return 0
        }
        console.error(`pm-go ps: ${psParse.error}`)
        console.error('')
        console.error(PS_USAGE)
        return 2
      }
      const entries = await readInstanceStateEntries(defaultStateFilePath())
      if (entries.length === 0) {
        console.log('(no pm-go-owned processes recorded)')
        return 0
      }
      for (const entry of entries) {
        console.log(`${entry.label.padEnd(10)} ${entry.pid}`)
      }
      return 0
    }

    case 'stop': {
      // T1a's `stop` slice will own this dispatch; until then we parse
      // --grace-ms here, send SIGTERM to every recorded pid, wait, then
      // SIGKILL anything still alive, then unlink the state file. The
      // intent matches the eventual T1a contract documented in the
      // session postmortem (P0).
      const stopParse = parseFlagsOnly(rest, ['--grace-ms'])
      if (!stopParse.ok) {
        if (stopParse.error === 'help') {
          console.log(STOP_USAGE)
          return 0
        }
        console.error(`pm-go stop: ${stopParse.error}`)
        console.error('')
        console.error(STOP_USAGE)
        return 2
      }
      const graceMsRaw = stopParse.values['--grace-ms']
      const graceMs = graceMsRaw === undefined ? 5000 : Number.parseInt(graceMsRaw, 10)
      if (!Number.isInteger(graceMs) || graceMs < 0) {
        console.error('pm-go stop: --grace-ms must be a non-negative integer')
        console.error(STOP_USAGE)
        return 2
      }
      const entries = await readInstanceStateEntries(defaultStateFilePath())
      if (entries.length === 0) {
        console.log('(no pm-go-owned processes recorded; nothing to stop)')
        return 0
      }
      for (const e of entries) {
        try {
          process.kill(e.pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      await delay(graceMs)
      for (const e of entries) {
        if (isPidAlive(e.pid)) {
          try {
            process.kill(e.pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
      }
      await productionRemoveInstanceState(defaultStateFilePath())
      return 0
    }

    case 'recover': {
      // T1a's `recover` slice will own this dispatch; until then we
      // sweep the state file, drop entries whose pid is no longer
      // alive, and rewrite the file with whatever remains.
      const recParse = parseFlagsOnly(rest, [])
      if (!recParse.ok) {
        if (recParse.error === 'help') {
          console.log(RECOVER_USAGE)
          return 0
        }
        console.error(`pm-go recover: ${recParse.error}`)
        console.error('')
        console.error(RECOVER_USAGE)
        return 2
      }
      const filePath = defaultStateFilePath()
      const entries = await readInstanceStateEntries(filePath)
      const live = entries.filter((e) => isPidAlive(e.pid))
      if (live.length === 0) {
        await productionRemoveInstanceState(filePath)
        console.log('(state file cleared; no live entries)')
        return 0
      }
      const body = `${JSON.stringify(live, null, 2)}\n`
      await mkdir(path.dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, filePath)
      for (const entry of live) {
        console.log(`${entry.label.padEnd(10)} ${entry.pid}`)
      }
      return 0
    }

    case '--help':
    case '-h': {
      console.log(ROOT_USAGE)
      return 0
    }

    case undefined: {
      console.error(ROOT_USAGE)
      return 1
    }

    default: {
      console.error(`Unknown subcommand: ${subcommand}`)
      console.error('')
      console.error(ROOT_USAGE)
      return 1
    }
  }
}

/**
 * Tiny argv splitter for the inline ps/stop/recover dispatchers. We
 * accept --help / -h, plus any flags whose names appear in
 * `flagsWithValues` (each must take exactly one value). Anything else
 * is rejected. Returns a tagged union so callers can render usage on
 * error consistently with the rest of the codebase.
 */
function parseFlagsOnly(
  argv: readonly string[],
  flagsWithValues: readonly string[],
):
  | { ok: true; values: Record<string, string | undefined> }
  | { ok: false; error: string } {
  const values: Record<string, string | undefined> = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') {
      return { ok: false, error: 'help' }
    }
    if (flag !== undefined && flagsWithValues.includes(flag)) {
      const v = argv[i + 1]
      if (v === undefined) {
        return { ok: false, error: `${flag} requires a value` }
      }
      values[flag] = v
      i++
      continue
    }
    return { ok: false, error: `unknown flag: ${flag ?? ''}` }
  }
  return { ok: true, values }
}

/**
 * Liveness probe: `kill(pid, 0)` is a POSIX no-op that throws ESRCH if
 * the pid is gone and EPERM if we don't own it. EPERM means it IS
 * alive, just unreachable; treat that as live too.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

/**
 * The CLI ships from `apps/cli/{src,dist}`. The monorepo root is two
 * directories up from the compiled/source entry — that's where the
 * supervisor must `cd` to spawn `pnpm --filter` commands.
 */
function resolveMonorepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

/**
 * Default state-file path. Per-instance config lives under
 * `~/.pm-go/instances/<name>/`; we use the implicit `default` instance
 * here because slice 1 only ships a single instance. A future flag
 * (`--instance <name>`) can override this without touching the seam.
 */
function defaultStateFilePath(): string {
  const home = os.homedir()
  return path.join(home, '.pm-go', 'instances', 'default', 'state.json')
}

/**
 * Inline state-file backend. T1a is meant to land a structured
 * `lib/instance-state.ts` module, but the wiring in this slice still
 * has to work even if T1a hasn't shipped yet — so we own the on-disk
 * shape here. Format is a JSON array of `InstanceStateEntry`s.
 *
 * `writeInstanceState` appends, deduping by `label` so a second boot
 * doesn't double up. `removeInstanceState` deletes the file outright
 * (atomic on a single FS) — a future T1a impl can refine this to a
 * write-then-rename if it ever needs partial removal.
 */
async function readInstanceStateEntries(filePath: string): Promise<InstanceStateEntry[]> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is InstanceStateEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { pid?: unknown }).pid === 'number' &&
        typeof (e as { label?: unknown }).label === 'string',
    )
  } catch {
    return []
  }
}

async function productionWriteInstanceState(
  filePath: string,
  entry: InstanceStateEntry,
): Promise<void> {
  const existing = await readInstanceStateEntries(filePath)
  // Dedupe on label so a re-run replaces the prior entry rather than
  // accumulating dead siblings.
  const next = existing.filter((e) => e.label !== entry.label)
  next.push(entry)
  const body = `${JSON.stringify(next, null, 2)}\n`
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, filePath)
}

async function productionRemoveInstanceState(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    throw err
  }
}

/**
 * Probe a single TCP port: try to bind to 127.0.0.1:`port`. If bind
 * fails with EADDRINUSE the port is in use; any other error is
 * surfaced to the caller. Pid attribution is left as `null` here —
 * binding doesn't tell us who's holding the port — and `owner` is
 * always `'unknown'`, which means a real process registry is needed
 * for "owned by pm-go" detection. T1a will replace this with a
 * proper `lsof` / `pmGoStateFile` consultation.
 */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, '127.0.0.1')
  })
}

async function productionCheckPorts(
  ports: readonly number[],
): Promise<PortPreflightResult> {
  const conflicts: PortConflict[] = []
  for (const port of ports) {
    if (!(await isPortFree(port))) {
      conflicts.push({ port, pid: null, owner: 'unknown' })
    }
  }
  if (conflicts.length === 0) return { ok: true }
  return { ok: false, conflicts }
}

function buildProductionSupervisorDeps(): Omit<
  RunDeps,
  'pm' | 'monorepoRoot'
> {
  const statePath = defaultStateFilePath()
  return {
    checkPorts: (ports) => productionCheckPorts(ports),
    writeInstanceState: (entry) => productionWriteInstanceState(statePath, entry),
    processPid: process.pid,
    exec: async (cmd, args, opts) => {
      try {
        const { stdout, stderr } = await execFile(cmd, [...args], {
          ...opts,
          maxBuffer: 64 * 1024 * 1024,
        })
        return { code: 0, stdout, stderr }
      } catch (err) {
        const e = err as NodeJS.ErrnoException & {
          code?: number | string
          stdout?: string
          stderr?: string
        }
        const numericCode =
          typeof e.code === 'number'
            ? e.code
            : typeof e.code === 'string'
              ? 1
              : 1
        return {
          code: numericCode,
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? e.message ?? '',
        }
      }
    },
    spawn: (cmd, args, opts) => nodeSpawn(cmd, [...args], opts ?? {}),
    fetch: globalThis.fetch.bind(globalThis),
    readFile: (p) => readFile(p, 'utf8'),
    fileExists: async (p) => {
      try {
        await access(p)
        return true
      } catch {
        return false
      }
    },
    mkdir: async (p, opts) => {
      await mkdir(p, opts)
    },
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    log: (l) => console.log(l),
    errLog: (l) => console.error(l),
  }
}

function buildProductionDriveDeps(): DriveDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    log: (l) => console.log(l),
    errLog: (l) => console.error(l),
    prompt: async (question) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        const answer = await new Promise<string>((resolve) => {
          rl.question(question, (a) => resolve(a))
        })
        const trimmed = answer.trim().toLowerCase()
        // Default-Yes: empty / 'y' / 'yes' all approve. Anything else
        // declines so an accidental Ctrl+C / EOF defaults to safe.
        return trimmed === '' || trimmed === 'y' || trimmed === 'yes'
      } finally {
        rl.close()
      }
    },
  }
}

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('pm-go failed:', err)
    process.exit(1)
  })
