/**
 * status subcommand — at-a-glance view of:
 *   - Worker config that pm-go will use (TEMPORAL_*, PM_GO_MODEL).
 *   - API health on the configured port.
 *   - Open Temporal workflows in the configured namespace.
 *
 * Goal is to answer "is anything stuck?" without raw tctl. Output is
 * intentionally text-only (no parsing of tctl output) so a tctl format
 * change doesn't break the command.
 *
 * All I/O is injected via StatusDeps so unit tests can run without
 * spawning processes or hitting localhost.
 *
 * As of v0.8.6+ the API section is gated by `probePmGoApi` from
 * `./lib/api-client.js`. The prior 2xx-only check would happily
 * print `✓ ok` against any service that returned a 200 on /health
 * (nginx, an unrelated dev server, another pm-go instance). The
 * identity probe parses the JSON envelope and rejects anything whose
 * service field isn't the literal `"pm-go-api"`. On mismatch the
 * structured error is printed verbatim — its first line begins with
 * the stable, greppable `[pm-go] port <port> is held by another
 * service` prefix — and runStatus returns 1 without continuing on
 * to the (possibly misleading) workflow listing.
 */

import {
  PmGoIdentityMismatchError,
  probePmGoApi,
} from './lib/api-client.js'

export interface StatusDeps {
  /** Run a child process and capture stdout/stderr. */
  exec: (
    cmd: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Process env (defaults to process.env in production). */
  env: Record<string, string | undefined>
  /** Network fetch — used only for the API /health probe. */
  fetch: typeof globalThis.fetch
  /** Output sink — one call per line. */
  write: (line: string) => void
  /** Monorepo root, so we run docker compose from the right cwd. */
  monorepoRoot: string
}

const DIVIDER = '─'.repeat(42)
const COL = 24

export async function runStatus(deps: StatusDeps): Promise<number> {
  const { exec, env, write } = deps
  const namespace = env.TEMPORAL_NAMESPACE ?? 'default'
  const taskQueue = env.TEMPORAL_TASK_QUEUE ?? 'pm-go-worker'
  const temporalAddress = env.TEMPORAL_ADDRESS ?? 'localhost:7233'
  const apiPort = env.API_PORT ?? '3001'

  write('pm-go status')
  write(DIVIDER)
  write('')

  // Worker / API config (from env, i.e. what a fresh boot would use).
  write('Worker config (env)')
  write(`  ${'TEMPORAL_ADDRESS'.padEnd(COL)} ${env.TEMPORAL_ADDRESS ?? `(default: ${temporalAddress})`}`)
  write(`  ${'TEMPORAL_NAMESPACE'.padEnd(COL)} ${env.TEMPORAL_NAMESPACE ?? `(default: ${namespace})`}`)
  write(`  ${'TEMPORAL_TASK_QUEUE'.padEnd(COL)} ${env.TEMPORAL_TASK_QUEUE ?? `(default: ${taskQueue})`}`)
  write(`  ${'PM_GO_MODEL'.padEnd(COL)} ${env.PM_GO_MODEL ?? '(unset; package defaults apply)'}`)
  write('')

  // API health + identity. Replaces the prior 2xx-only probe: a port
  // held by another service (e.g. nginx returning {"status":"ok"})
  // would have printed `✓ ok` even though running drive against it
  // would have produced confusing 404s. probePmGoApi parses the JSON
  // identity envelope and throws PmGoIdentityMismatchError with the
  // `[pm-go] port <port> is held by another service` prefix on any
  // mismatch (including network errors and HTTP non-2xx); we surface
  // the message verbatim and return 1 without printing the rest of
  // the status output.
  write('API')
  const probeUrl = `http://localhost:${apiPort}/health`
  // Wrap deps.fetch to apply the same 3s timeout the prior 2xx check
  // used. probePmGoApi calls fetchImpl(url) with no init, so the
  // wrapper is the only place to inject the signal in production
  // without breaking the unit-test mock signature.
  const probeFetch: typeof globalThis.fetch = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    deps.fetch(input, {
      ...init,
      signal: AbortSignal.timeout(3000),
    })) as typeof globalThis.fetch
  try {
    await probePmGoApi(probeFetch, probeUrl)
    write(`  ${probeUrl.padEnd(COL)} ✓ ok`)
  } catch (err) {
    if (err instanceof PmGoIdentityMismatchError) {
      // Each line of the structured error becomes its own `write`
      // call so the sink can render them as separate log lines (the
      // production sink is `console.log`, which expects one line per
      // call to keep the output tidy).
      for (const line of err.message.split('\n')) {
        write(line)
      }
      return 1
    }
    throw err
  }
  write('')

  // Open workflows. tctl is the most portable surface inside the
  // temporal container; we don't parse its output — operators read it
  // verbatim. If tctl is unavailable (container down) we say so.
  //
  // The temporal server binds only to the container's bridge IP
  // (e.g. 172.21.0.3:7233), not to `localhost` / `127.0.0.1`, so
  // tctl-from-inside-container with the loopback address is refused.
  // `$(hostname -i)` resolves to that bridge IP at runtime regardless
  // of which Docker network compose picked. Discovered during the
  // v0.8.6 dogfood when `pm-go status` falsely reported temporal down.
  // Using `sh -c` because we need shell substitution.
  write(`Open workflows (namespace=${namespace})`)
  try {
    const args = [
      'compose',
      'exec',
      '-T',
      'temporal',
      'sh',
      '-c',
      `tctl --ad "$(hostname -i):7233" --ns ${shellQuote(namespace)} workflow list -m 50 -op`,
    ]
    const r = await exec('docker', args)
    if (r.code === 0) {
      const body = r.stdout.trimEnd()
      if (body.length === 0) {
        write('  (no open workflows)')
      } else {
        for (const line of body.split('\n')) {
          write(`  ${line}`)
        }
      }
    } else {
      const reason = (r.stderr || r.stdout || `exit ${r.code}`)
        .trim()
        .split('\n')[0]
      write(`  ✗ tctl: ${reason}`)
      write(
        `  hint: is the temporal container up? Run \`pm-go doctor\` to check.`,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    write(`  ✗ docker exec failed: ${msg}`)
  }
  write('')

  // The numbers above are advisory; doctor is the authoritative health
  // check. status's exit code is always 0 so it composes well in
  // shell pipelines (`pm-go status && pm-go drive --plan ...`).
  return 0
}

/**
 * Single-quote a value for safe substitution into a `sh -c` command.
 * Used by the workflow-list call so that an attacker-controlled
 * namespace value can't escape into shell metacharacters.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export const STATUS_USAGE = `Usage: pm-go status

Show the worker's expected Temporal config, the API /health probe, and
open workflows in the configured namespace. Useful when a workflow
appears stuck and you want to see whether the worker is even on the
right task queue.

This command does not modify any state. For diagnostics + auto-repair,
use \`pm-go doctor --repair\`.

Options:
  -h, --help  Show this message.`
