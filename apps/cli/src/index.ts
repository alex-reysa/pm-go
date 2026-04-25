#!/usr/bin/env node
/**
 * pm-go CLI entrypoint.
 *
 * Subcommands:
 *   pm-go run [options]   Bring up the local stack, optionally submit a spec,
 *                          and stay attached. Replaces the three-terminal flow.
 *   pm-go doctor          Probe API keys / local CLIs / runtime resolution.
 *
 * Examples:
 *   pm-go run                                       # boot the stack only
 *   pm-go run --spec ./examples/golden-path/spec.md # boot + submit spec
 *   pm-go doctor                                    # diagnostics
 */

import { spawn as nodeSpawn, execFile as execFileCb } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { detectAvailableRuntimes } from '@pm-go/runtime-detector'

import { runDoctor } from './doctor.js'
import { applyDotenv } from './lib/dotenv.js'
import {
  runCli,
  RUN_USAGE,
  type RunCliDeps,
  type RunDeps,
} from './run.js'

const execFile = promisify(execFileCb)

const ROOT_USAGE = `Usage: pm-go <command> [options]

Commands:
  run         Start the pm-go control plane (one-command supervisor).
  doctor      Probe runtimes + diagnose configuration.

Run \`pm-go <command> --help\` for command-specific options.`

const [, , subcommand, ...rest] = process.argv

async function main(): Promise<number> {
  switch (subcommand) {
    case 'doctor': {
      return runDoctor({
        detectRuntimes: detectAvailableRuntimes,
        env: process.env,
        write: console.log,
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

void main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('pm-go failed:', err)
    process.exit(1)
  })
