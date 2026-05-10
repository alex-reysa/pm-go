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

import {
  agentCli,
  type AgentOptions,
  type AgentCliDeps,
} from './agent.js'
import {
  runDoctor,
  type InfraProbeDeps,
  type RepairDeps,
} from './doctor.js'
import {
  decomposeCli,
  DECOMPOSE_USAGE,
  type DecomposeCliDeps,
  type DecomposeDeps,
} from './decompose.js'
import {
  driveCli,
  DRIVE_USAGE,
  EXIT_PAUSED,
  runDrive,
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
  runSupervisor,
  RUN_USAGE,
  type InstanceStateEntry,
  type PortConflict,
  type PortPreflightResult,
  type RunCliDeps,
  type RunDeps,
  type RunOptions,
  type SpecToPlanWorkflowDescription,
} from './run.js'
import { createProcessManager } from './lib/process-manager.js'
import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from './lib/api-client.js'
import { runStatus, STATUS_USAGE } from './status.js'
import { runWhy, WHY_USAGE } from './why.js'

const execFile = promisify(execFileCb)

const ROOT_USAGE = `Usage: pm-go <command> [options]

Commands:
  agent       Start the agentic operator (default when no legacy command is used).
  implement   Boot stack + submit spec + drive to release in one command.
  run         Start the pm-go control plane (supervisor only).
  drive       Drive a submitted plan to released against a running stack.
  decompose   Layer-A: split a spec into milestones, edit, plan-first.
  status      Show worker config, API health, and open Temporal workflows.
  why         Explain in one sentence why a plan/phase/task is in its state.
  doctor      Probe runtimes + diagnose configuration. Use --repair to fix.
  ps          List supervisor / worker / api / drive pids pm-go owns.
  stop        Stop every pm-go-owned process (SIGTERM then SIGKILL).
  recover     Drop dead entries from the state file.

Run \`pm-go <command> --help\` for command-specific options.

Quickest path:
  pm-go --repo . --spec ./feature.md`

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

const LEGACY_SUBCOMMANDS = new Set([
  'doctor',
  'run',
  'drive',
  'status',
  'why',
  'ps',
  'stop',
  'recover',
])

export type CliDispatch =
  | { kind: 'root-help' }
  | { kind: 'agent'; argv: string[]; compatibilityLog?: string }
  | { kind: 'legacy'; subcommand: string; argv: string[] }
  | { kind: 'unknown'; subcommand: string }

export function resolveCliDispatch(argv: readonly string[]): CliDispatch {
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h') {
    return { kind: 'root-help' }
  }
  if (first === undefined) {
    return { kind: 'agent', argv: [] }
  }
  if (first === 'agent') {
    return { kind: 'agent', argv: rest }
  }
  if (first === 'implement') {
    const legacyIndex = rest.indexOf('--legacy-drive')
    if (legacyIndex !== -1) {
      const legacyArgv = [...rest]
      legacyArgv.splice(legacyIndex, 1)
      return { kind: 'legacy', subcommand: 'implement', argv: legacyArgv }
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      return { kind: 'legacy', subcommand: 'implement', argv: rest }
    }
    return {
      kind: 'agent',
      argv: rest,
      compatibilityLog:
        '[pm-go] `pm-go implement` now runs the agentic operator. Use `pm-go implement --legacy-drive` for the legacy drive flow.',
    }
  }
  if (LEGACY_SUBCOMMANDS.has(first)) {
    return { kind: 'legacy', subcommand: first, argv: rest }
  }
  if (first.startsWith('-')) {
    return { kind: 'agent', argv: [...argv] }
  }
  return { kind: 'unknown', subcommand: first }
}

async function main(): Promise<number> {
  const dispatch = resolveCliDispatch(process.argv.slice(2))
  if (dispatch.kind === 'root-help') {
    console.log(ROOT_USAGE)
    return 0
  }
  if (dispatch.kind === 'agent') {
    if (dispatch.compatibilityLog) {
      console.log(dispatch.compatibilityLog)
    }
    const userCwd = process.env.INIT_CWD ?? process.cwd()
    const agentCliDeps: AgentCliDeps = {
      argv: dispatch.argv,
      cwd: userCwd,
      log: (l) => console.log(l),
      errLog: (l) => console.error(l),
      resolve: (base, p) => (path.isAbsolute(p) ? p : path.resolve(base, p)),
      runOperatorAgent: (options) =>
        runProductionOperatorAgent(options, {
          monorepoRoot: resolveMonorepoRoot(),
          log: (l) => console.log(l),
          errLog: (l) => console.error(l),
        }),
    }
    return agentCli(agentCliDeps)
  }
  if (dispatch.kind === 'unknown') {
    console.error(`Unknown subcommand: ${dispatch.subcommand}`)
    console.error('')
    console.error(ROOT_USAGE)
    return 1
  }

  const subcommand = dispatch.subcommand
  const rest = dispatch.argv
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
      const { detectAvailableRuntimes } = await import('@pm-go/runtime-detector')
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

    case 'decompose': {
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(DECOMPOSE_USAGE)
        return 0
      }
      // Same INIT_CWD-aware resolution as `run` / `implement` so
      // `--repo .` / `--spec ./feature.md` work under the
      // `pnpm --filter @pm-go/cli exec` invocation mode.
      const userCwd = process.env.INIT_CWD ?? process.cwd()
      const decomposeCliDeps: DecomposeCliDeps = {
        argv: rest,
        cwd: userCwd,
        resolve: (base, p) => (path.isAbsolute(p) ? p : path.resolve(base, p)),
        log: (l) => console.log(l),
        errLog: (l) => console.error(l),
        buildDecomposeDeps: () => buildProductionDecomposeDeps(),
      }
      return decomposeCli(decomposeCliDeps)
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

    case 'why': {
      if (rest[0] === '--help' || rest[0] === '-h') {
        console.log(WHY_USAGE)
        return 0
      }
      const monorepoRoot = resolveMonorepoRoot()
      // Mirror the status case: load .env so why hits the same API_PORT
      // a fresh boot would, without forcing the operator to remember
      // which port the supervisor picked.
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
      return runWhy(
        {
          fetch: globalThis.fetch.bind(globalThis),
          env: process.env,
          write: (l) => console.log(l),
          errLog: (l) => console.error(l),
        },
        rest,
      )
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
        const staleRuns = await recoverStaleOrchestratorRuns({
          monorepoRoot: resolveMonorepoRoot(),
        })
        console.log('(state file cleared; no live entries)')
        console.log(formatStaleOrchestratorRunRecovery(staleRuns))
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
      console.log('(agent_runs cleanup skipped; live pm-go entries remain)')
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

interface ProductionOperatorAgentDeps {
  monorepoRoot: string
  log: (line: string) => void
  errLog: (line: string) => void
  fetch?: typeof globalThis.fetch
  loadOperatorAgent?: () => Promise<{
    runOperatorAgent?: (
      options: AgentOptions,
      deps?: {
        fetchImpl?: typeof globalThis.fetch
        handlers?: PmGoToolHandlers
      },
    ) => Promise<OperatorAgentResult>
  }>
  createStackController?: (
    options: AgentOptions,
    deps: ProductionOperatorAgentDeps,
  ) => AgentStackController
}

interface AgentStackController {
  ensure(input: {
    repoRoot?: string | undefined
    runtime?: string | undefined
    apiUrl: string
  }): Promise<Record<string, unknown>>
  stop(): Promise<Record<string, unknown>>
  readonly apiUrl: string | undefined
}

interface OperatorAgentResult {
  status: 'completed' | 'failed'
  text: string
}

interface PmGoToolHandlers {
  doctor?: (input: {
    repair?: boolean | undefined
    verbose?: boolean | undefined
  }) => Promise<Record<string, unknown>>
  recover?: () => Promise<Record<string, unknown>>
  ensureStack?: (input: {
    repoRoot?: string | undefined
    runtime?: string | undefined
    apiUrl: string
  }) => Promise<Record<string, unknown>>
  stop?: () => Promise<Record<string, unknown>>
  drivePlan?: (input: {
    planId: string
    approve: 'all' | 'none' | 'interactive'
  }) => Promise<Record<string, unknown>>
}

export async function runProductionOperatorAgent(
  options: AgentOptions,
  deps: ProductionOperatorAgentDeps,
): Promise<number> {
  const mod = deps.loadOperatorAgent
    ? await deps.loadOperatorAgent()
    : await loadOperatorAgentModule()
  if (typeof mod.runOperatorAgent !== 'function') {
    deps.errLog('pm-go agent: @pm-go/orchestrator does not export runOperatorAgent')
    return 1
  }

  const stack = deps.createStackController
    ? deps.createStackController(options, deps)
    : createAgentStackController(options, deps)
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const handlers: PmGoToolHandlers = {
    async doctor() {
      const apiUrl = resolveAgentApiUrl(options)
      return {
        status: (await isPmGoApiReachable(apiUrl, fetchImpl)) ? 'ok' : 'api_unreachable',
        apiUrl,
      }
    },
    async recover() {
      return recoverInstanceState()
    },
    async ensureStack(input) {
      return stack.ensure(input)
    },
    async stop() {
      return stack.stop()
    },
    async drivePlan(input) {
      const apiUrl = stack.apiUrl ?? resolveAgentApiUrl(options)
      const planReady = await waitForAgentPlanReady(
        apiUrl,
        input.planId,
        fetchImpl,
        deps.log,
      )
      if (!planReady) {
        return {
          status: 'planning',
          planId: input.planId,
          message:
            'plan row is not queryable yet; planner workflow may still be running',
        }
      }
      const exitCode = await runDrive(
        {
          planId: input.planId,
          apiUrl,
          approve: input.approve,
        },
        buildProductionDriveDeps(),
      )
      return {
        status:
          exitCode === 0
            ? 'released'
            : exitCode === EXIT_PAUSED
              ? 'paused'
              : 'blocked',
        exitCode,
        planId: input.planId,
      }
    },
  }

  try {
    const ensureResult = await stack.ensure({
      repoRoot: options.repoRoot,
      runtime: options.runtime,
      apiUrl: resolveAgentApiUrl(options),
    })
    if (!isReadyAgentStack(ensureResult)) {
      deps.errLog(
        `pm-go agent: unable to ensure pm-go API (${JSON.stringify(ensureResult)})`,
      )
      return 1
    }
    const ensuredApiUrl =
      typeof ensureResult.apiUrl === 'string'
        ? ensureResult.apiUrl
        : resolveAgentApiUrl(options)
    const result = await mod.runOperatorAgent({ ...options, apiUrl: ensuredApiUrl }, {
      fetchImpl,
      handlers,
    })
    if (typeof result.text === 'string' && result.text.trim().length > 0) {
      deps.log(result.text)
    }
    return result.status === 'completed' ? 0 : 1
  } finally {
    await stack.stop().catch(() => undefined)
  }
}

async function waitForAgentPlanReady(
  apiUrl: string,
  planId: string,
  fetchImpl: typeof globalThis.fetch,
  log: (line: string) => void,
): Promise<boolean> {
  const waitMs = 45 * 60_000
  const intervalMs = 1_000
  const startedAt = Date.now()
  let nextHeartbeatAt = startedAt + 60_000
  while (Date.now() - startedAt <= waitMs) {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/plans/${planId}`)
    if (res.ok) return true
    if (res.status !== 404) return false
    const now = Date.now()
    if (now >= nextHeartbeatAt) {
      log(
        `[agent] waiting for plan ${planId} to become queryable (${Math.floor(
          (now - startedAt) / 60_000,
        )}m elapsed)`,
      )
      nextHeartbeatAt += 60_000
    }
    await delay(intervalMs)
  }
  return false
}

async function loadOperatorAgentModule(): Promise<{
  runOperatorAgent?: (
    options: AgentOptions,
    deps?: {
      fetchImpl?: typeof globalThis.fetch
      handlers?: PmGoToolHandlers
    },
  ) => Promise<OperatorAgentResult>
}> {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier)',
  ) as (specifier: string) => Promise<unknown>
  return (await dynamicImport('@pm-go/orchestrator')) as {
    runOperatorAgent?: (
      options: AgentOptions,
      deps?: {
        fetchImpl?: typeof globalThis.fetch
        handlers?: PmGoToolHandlers
      },
    ) => Promise<OperatorAgentResult>
  }
}

function isReadyAgentStack(value: Record<string, unknown>): value is Record<string, unknown> & {
  apiUrl?: string
} {
  return value.status === 'reachable' || value.status === 'started'
}

function createAgentStackController(
  options: AgentOptions,
  agentDeps: ProductionOperatorAgentDeps,
): AgentStackController {
  let current:
    | {
        apiUrl: string
        release: () => void
        done: Promise<number>
      }
    | undefined

  async function ensure(input: {
    repoRoot?: string | undefined
    runtime?: string | undefined
    apiUrl: string
  }): Promise<Record<string, unknown>> {
    const apiUrl = input.apiUrl.replace(/\/+$/, '')
    if (await isPmGoApiReachable(apiUrl, agentDeps.fetch ?? globalThis.fetch.bind(globalThis))) {
      return { status: 'reachable', apiUrl, started: false }
    }
    if (current) {
      return { status: 'starting_or_running', apiUrl: current.apiUrl, started: true }
    }
    if (!isLocalAgentApiUrl(apiUrl)) {
      return {
        status: 'unreachable',
        apiUrl,
        message: 'explicit non-local apiUrl cannot be started by pm-go',
      }
    }

    const apiPort = portFromApiUrl(apiUrl) ?? options.apiPort ?? 3001
    let releaseKeepAlive: (() => void) | undefined
    let readySettled = false
    let readyResolve:
      | ((handle: { apiUrl: string }) => void)
      | undefined
    let readyReject: ((err: Error) => void) | undefined
    const ready = new Promise<{ apiUrl: string }>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    const keepAlive = new Promise<number>((resolve) => {
      releaseKeepAlive = () => resolve(0)
    })
    const supervisorDeps = buildProductionSupervisorDeps()
    const pm = createProcessManager({
      process,
      log: agentDeps.errLog,
      removeInstanceState: () =>
        productionRemoveInstanceState(defaultStateFilePath()),
    })
    const runOptions: RunOptions = {
      repoRoot: input.repoRoot ?? options.repoRoot,
      specPath: options.specPath,
      submitSpecOnBoot: false,
      title: options.title,
      runtime: (input.runtime ?? options.runtime) as RunOptions['runtime'],
      apiPort,
      databaseUrl:
        process.env.DATABASE_URL ?? 'postgres://pmgo:pmgo@localhost:5432/pm_go',
      skipDocker: false,
      skipMigrate: false,
    }

    const done = runSupervisor(
      runOptions,
      {
        ...supervisorDeps,
        pm,
        monorepoRoot: agentDeps.monorepoRoot,
      },
      async (handle) => {
        readySettled = true
        readyResolve?.({ apiUrl: handle.apiUrl })
        return keepAlive
      },
    ).then(
      (code) => {
        if (!readySettled) {
          readyReject?.(
            new Error(`supervisor exited before API became ready (code ${code})`),
          )
        }
        return code
      },
      (err) => {
        if (!readySettled) {
          readyReject?.(err instanceof Error ? err : new Error(String(err)))
        }
        throw err
      },
    )

    current = {
      apiUrl: `http://localhost:${apiPort}`,
      release: releaseKeepAlive ?? (() => undefined),
      done,
    }
    try {
      const handle = await ready
      current.apiUrl = handle.apiUrl
      return { status: 'started', apiUrl: handle.apiUrl, started: true }
    } catch (err) {
      current = undefined
      return {
        status: 'failed',
        apiUrl,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async function stop(): Promise<Record<string, unknown>> {
    if (!current) return { status: 'not_started' }
    const active = current
    current = undefined
    active.release()
    const exitCode = await active.done.catch(() => 1)
    return { status: 'stopped', apiUrl: active.apiUrl, exitCode }
  }

  return {
    ensure,
    stop,
    get apiUrl() {
      return current?.apiUrl
    },
  }
}

async function isPmGoApiReachable(
  apiUrl: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<boolean> {
  try {
    await probePmGoApi(fetchImpl, `${apiUrl.replace(/\/+$/, '')}/health`)
    return true
  } catch (err) {
    if (
      err instanceof PmGoIdentityMismatchError &&
      err.message.includes('detail: network error:')
    ) {
      return false
    }
    throw err
  }
}

async function isApiReachable(apiUrl: string): Promise<boolean> {
  try {
    return await isPmGoApiReachable(apiUrl, globalThis.fetch.bind(globalThis))
  } catch {
    return false
  }
}

function resolveAgentApiUrl(options: AgentOptions): string {
  return (options.apiUrl ?? `http://127.0.0.1:${options.apiPort ?? 3001}`)
    .replace(/\/+$/, '')
}

function isLocalAgentApiUrl(apiUrl: string): boolean {
  try {
    const host = new URL(apiUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

function portFromApiUrl(apiUrl: string): number | undefined {
  try {
    const parsed = new URL(apiUrl)
    if (parsed.port) return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return undefined
  }
}

async function recoverInstanceState(): Promise<Record<string, unknown>> {
  const filePath = defaultStateFilePath()
  const entries = await readInstanceStateEntries(filePath)
  const live = entries.filter((e) => isPidAlive(e.pid))
  if (live.length === 0) {
    await productionRemoveInstanceState(filePath)
    return { status: 'cleared', liveCount: 0 }
  }
  const body = `${JSON.stringify(live, null, 2)}\n`
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, filePath)
  return { status: 'live_entries_remain', liveCount: live.length, entries: live }
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

export type StaleOrchestratorRunRecovery =
  | { status: 'updated'; count: number }
  | { status: 'skipped'; reason: string }

export async function recoverStaleOrchestratorRuns(input: {
  monorepoRoot: string
  exec?: (
    cmd: string,
    args: readonly string[],
    opts: { cwd: string; maxBuffer: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>
}): Promise<StaleOrchestratorRunRecovery> {
  const sql = [
    'WITH updated AS (',
    '  UPDATE agent_runs',
    "  SET status = 'failed',",
    '      completed_at = now(),',
    "      stop_reason = 'error',",
    "      error_reason = COALESCE(error_reason, 'recover: orphaned by previous supervisor')",
    "  WHERE status = 'running'",
    "    AND role = 'orchestrator'",
    '    AND plan_id IS NULL',
    '    AND completed_at IS NULL',
    '  RETURNING id',
    ')',
    'SELECT count(*)::int FROM updated;',
  ].join('\n')
  const exec =
    input.exec ??
    ((cmd, args, opts) =>
      execFile(cmd, [...args], opts).then(
        ({ stdout, stderr }) => ({
          code: 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
        (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }) => ({
          code: typeof err.code === 'number' ? err.code : 1,
          stdout: String(err.stdout ?? ''),
          stderr: String(err.stderr ?? err.message ?? ''),
        }),
      ))
  const result = await exec('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'pmgo',
    '-d',
    'pm_go',
    '-tA',
    '-c',
    sql,
  ], {
    cwd: input.monorepoRoot,
    maxBuffer: 1024 * 1024,
  })
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || `exit ${result.code}`)
      .trim()
      .split('\n')[0]
    return {
      status: 'skipped',
      reason: reason || 'postgres cleanup command failed',
    }
  }
  const count = Number.parseInt(result.stdout.trim(), 10)
  return {
    status: 'updated',
    count: Number.isInteger(count) ? count : 0,
  }
}

export function formatStaleOrchestratorRunRecovery(
  result: StaleOrchestratorRunRecovery,
): string {
  if (result.status === 'updated') {
    return `(agent_runs cleanup: marked ${result.count} stale orchestrator run(s) failed)`
  }
  return `(agent_runs cleanup skipped: ${result.reason})`
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

async function productionDescribeSpecToPlanWorkflow(
  workflowId: string,
  monorepoRoot: string,
): Promise<SpecToPlanWorkflowDescription> {
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default'
  const r = await execFile('docker', [
    'compose',
    'exec',
    '-T',
    'temporal',
    'sh',
    '-c',
    `tctl --ad "$(hostname -i):7233" --ns ${shellQuote(namespace)} workflow describe --wid ${shellQuote(workflowId)}`,
  ], {
    cwd: monorepoRoot,
    maxBuffer: 8 * 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }) => ({
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
    }),
  )
  const output = `${r.stdout}\n${r.stderr}`.trim()
  if (r.code !== 0) {
    const lowered = output.toLowerCase()
    return {
      workflowId,
      status: lowered.includes('not found') ? 'not_found' : 'unknown',
      ...(output ? { detail: output.split('\n')[0] } : {}),
    }
  }
  return {
    workflowId,
    status: parseTemporalWorkflowStatus(output),
    ...(output ? { detail: output.split('\n')[0] } : {}),
  }
}

function parseTemporalWorkflowStatus(output: string): SpecToPlanWorkflowDescription['status'] {
  const match =
    output.match(/Status\s*:\s*([A-Za-z_]+)/i) ??
    output.match(/Status\s+([A-Za-z_]+)/i) ??
    output.match(/WorkflowExecutionStatus\s*:\s*([A-Za-z_]+)/i)
  const raw = match?.[1]?.toLowerCase().replace(/^workflow_execution_status_/, '')
  switch (raw) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'terminated':
      return 'terminated'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'timed_out':
    case 'timeout':
      return 'timed_out'
    case 'continued_as_new':
      return 'continued_as_new'
    default:
      return 'unknown'
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
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
    describeSpecToPlanWorkflow: (workflowId) =>
      productionDescribeSpecToPlanWorkflow(workflowId, resolveMonorepoRoot()),
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

function buildProductionDecomposeDeps(): DecomposeDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    log: (l) => console.log(l),
    errLog: (l) => console.error(l),
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: async (p, contents) => {
      await writeFile(p, contents, 'utf8')
    },
    makeTempfile: async (suggestedName) => {
      // Land the manifest in `${TMPDIR}/pm-go/<suggestedName>` so the
      // editor opens a stable path the operator can reopen with their
      // history. We don't strictly need uniqueness — the suggested
      // name carries the `decompositionId`, which is itself a UUID —
      // but mkdir-recursive is harmless if the dir already exists.
      const dir = path.join(os.tmpdir(), 'pm-go')
      await mkdir(dir, { recursive: true })
      return path.join(dir, suggestedName)
    },
    openEditor: async (filePath) => {
      const editor =
        process.env.VISUAL || process.env.EDITOR || 'vi'
      // The editor inherits stdio so the operator gets a real TTY
      // experience. `shell: false` prevents argv injection if the env
      // var carries spaces — a path like "/usr/bin/code --wait" needs
      // explicit support, but `vi` and friends have no flags here.
      await new Promise<void>((resolve, reject) => {
        const child = nodeSpawn(editor, [filePath], {
          stdio: 'inherit',
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${editor} exited with code ${code}`))
        })
      })
    },
    basename: (p, ext) => path.basename(p, ext),
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)

if (invokedPath === modulePath) {
  void main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('pm-go failed:', err)
      process.exit(1)
    })
}
