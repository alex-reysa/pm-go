/**
 * doctor subcommand — probes API keys, local CLIs, and resolves --runtime auto.
 *
 * All I/O is injected via DoctorDeps so unit tests can run without real
 * child-process spawning or real environment variables.
 */

/** Minimal shape we need from a detected runtime entry. */
interface DetectedRuntime {
  adapter: { cliCommand: string }
  version: string
}

export interface DoctorDeps {
  /** Returns the list of CLIs that are currently available on PATH. */
  detectRuntimes: () => Promise<DetectedRuntime[]>
  /** Environment variable map (defaults to process.env in production). */
  env: Record<string, string | undefined>
  /** Output sink — one call per line (defaults to console.log). */
  write: (line: string) => void
}

// ---------------------------------------------------------------------------
// Auto-resolution logic
// ---------------------------------------------------------------------------

export type ResolutionKind =
  | 'anthropic-sdk'
  | 'claude-cli'
  | 'openrouter-sdk'
  | 'openai-sdk'
  | 'none'

export interface ResolutionResult {
  kind: ResolutionKind
  reason: string
}

/**
 * Resolve --runtime auto for the default role set.
 *
 * Priority order:
 *   1. ANTHROPIC_API_KEY set → anthropic-sdk
 *   2. claude CLI on PATH    → claude-cli
 *   3. OPENROUTER_API_KEY    → openrouter-sdk
 *   4. OPENAI_API_KEY        → openai-sdk
 *   5. nothing               → none
 */
export function resolveAutoRuntime(
  env: Record<string, string | undefined>,
  runtimes: DetectedRuntime[],
): ResolutionResult {
  if (env['ANTHROPIC_API_KEY']) {
    return { kind: 'anthropic-sdk', reason: 'ANTHROPIC_API_KEY is set' }
  }
  if (runtimes.some((r) => r.adapter.cliCommand === 'claude')) {
    return { kind: 'claude-cli', reason: 'claude CLI found on PATH' }
  }
  if (env['OPENROUTER_API_KEY']) {
    return { kind: 'openrouter-sdk', reason: 'OPENROUTER_API_KEY is set' }
  }
  if (env['OPENAI_API_KEY']) {
    return { kind: 'openai-sdk', reason: 'OPENAI_API_KEY is set' }
  }
  return { kind: 'none', reason: 'no supported runtime available' }
}

// ---------------------------------------------------------------------------
// Output builder (returns string for snapshot testing)
// ---------------------------------------------------------------------------

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY'] as const
const CLI_NAMES = ['claude', 'codex', 'gemini'] as const
const DIVIDER = '─'.repeat(42)
const COL = 24 // left-column width for name

/** Build the doctor report string (without trailing newline). */
export function buildDoctorReport(
  env: Record<string, string | undefined>,
  runtimes: DetectedRuntime[],
): string {
  const lines: string[] = []

  // Header
  lines.push('pm-go doctor')
  lines.push(DIVIDER)
  lines.push('')

  // Environment block
  lines.push('Environment')
  for (const key of ENV_KEYS) {
    const marker = env[key] ? '✓ set' : 'not set'
    lines.push(`  ${key.padEnd(COL)} ${marker}`)
  }
  lines.push('')

  // Local CLIs block
  lines.push('Local CLIs')
  const runtimeMap = new Map(runtimes.map((r) => [r.adapter.cliCommand, r.version]))
  for (const cli of CLI_NAMES) {
    const version = runtimeMap.get(cli)
    const marker = version !== undefined ? `✓ ${version}` : 'not found'
    lines.push(`  ${cli.padEnd(COL)} ${marker}`)
  }
  lines.push('')

  // Runtime resolution block
  const resolution = resolveAutoRuntime(env, runtimes)
  lines.push('Runtime resolution')
  if (resolution.kind === 'none') {
    lines.push(`  --runtime auto           → ${resolution.reason}`)
  } else {
    lines.push(`  --runtime auto           → ${resolution.kind}  (${resolution.reason})`)
  }
  lines.push('')

  // Infrastructure block
  lines.push('Infrastructure')
  lines.push('  (no additional checks in v0.8.0)')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public entry-point
// ---------------------------------------------------------------------------

/**
 * Run the doctor subcommand.
 *
 * @returns exit code — 0 when at least one supported runtime is available,
 *          1 when none is available.
 */
export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const runtimes = await deps.detectRuntimes()
  const report = buildDoctorReport(deps.env, runtimes)

  for (const line of report.split('\n')) {
    deps.write(line)
  }

  const resolution = resolveAutoRuntime(deps.env, runtimes)
  return resolution.kind === 'none' ? 1 : 0
}
