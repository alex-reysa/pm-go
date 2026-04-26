#!/usr/bin/env node
/**
 * pm-go CLI entrypoint.
 *
 * Subcommands:
 *   pm-go run [options]    Bring up the local stack, optionally submit a spec,
 *                           and stay attached. Replaces the three-terminal flow.
 *   pm-go drive [options]  Drive a submitted plan to released by sequencing
 *                           API calls (run/review/fix/integrate/audit/release).
 *   pm-go doctor [options] Probe API keys / local CLIs / runtime / infra; can
 *                           auto-repair fixable problems with --repair.
 *
 * Examples:
 *   pm-go run                                       # boot the stack only
 *   pm-go run --spec ./examples/golden-path/spec.md # boot + submit spec
 *   pm-go drive --plan <uuid>                       # drive plan to released
 *   pm-go doctor                                    # diagnostics
 *   pm-go doctor --repair                           # diagnose + auto-fix
 */

import { spawn as nodeSpawn, execFile as execFileCb } from 'node:child_process'
import { access, constants, mkdir, readFile } from 'node:fs/promises'
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

Run \`pm-go <command> --help\` for command-specific options.

Quickest path:
  pm-go implement --repo . --spec ./feature.md`

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
      return runDoctor({
        detectRuntimes: detectAvailableRuntimes,
        env: process.env,
        write: console.log,
        infra,
        repairDeps,
        repair,
        verbose,
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
 * The CLI ships from `apps/cli/{src,dist}`. The monorepo root is two
 * directories up from the compiled/source entry — that's where the
 * supervisor must `cd` to spawn `pnpm --filter` commands.
 */
function resolveMonorepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, '..', '..', '..')
}

function buildProductionSupervisorDeps(): Omit<
  RunDeps,
  'pm' | 'monorepoRoot'
> {
  return {
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
