import { execFile } from 'node:child_process';
import type { RuntimeAdapter, DetectedRuntime } from './types.js';

// ---------------------------------------------------------------------------
// Injectable runner — replaced by tests to avoid real child-process spawning.
// ---------------------------------------------------------------------------

type VersionRunner = (cmd: string) => Promise<string | null>;

let _testRunner: VersionRunner | null = null;

/**
 * Override the version runner used by detectVersionCached.
 * Pass `null` to restore the default (real execFile) behaviour.
 * Intended for unit tests only.
 */
export function _setRunnerForTesting(runner: VersionRunner | null): void {
  _testRunner = runner;
}

// ---------------------------------------------------------------------------
// Real runner — shells out `<cmd> --version` and parses the semver string.
// ---------------------------------------------------------------------------

function defaultRunner(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const text = stdout.trim();
      const match = text.match(/(\d+\.\d+\.\d+)/);
      resolve(match ? (match[1] ?? null) : (text.length > 0 ? text : null));
    });
  });
}

// ---------------------------------------------------------------------------
// 60-second in-process TTL cache.
// ---------------------------------------------------------------------------

const TTL_MS = 60_000;

interface CacheEntry {
  version: string | null;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

/** Clear all cached version results. Useful between tests. */
export function clearDetectionCache(): void {
  cache.clear();
}

async function detectVersionCached(cmd: string): Promise<string | null> {
  const now = Date.now();
  const entry = cache.get(cmd);
  if (entry !== undefined && now - entry.timestamp < TTL_MS) {
    return entry.version;
  }
  const runner = _testRunner ?? defaultRunner;
  const version = await runner(cmd);
  cache.set(cmd, { version, timestamp: now });
  return version;
}

// ---------------------------------------------------------------------------
// Known adapters.
// ---------------------------------------------------------------------------

const KNOWN_CLI_COMMANDS = ['claude', 'codex', 'gemini'] as const;
type KnownCliCommand = (typeof KNOWN_CLI_COMMANDS)[number];

function makeAdapter(
  name: string,
  cliCommand: KnownCliCommand,
  capabilities: RuntimeAdapter['capabilities'],
): RuntimeAdapter {
  return {
    name,
    cliCommand,
    async detectAvailable(): Promise<boolean> {
      return (await detectVersionCached(cliCommand)) !== null;
    },
    async detectVersion(): Promise<string | null> {
      return detectVersionCached(cliCommand);
    },
    capabilities,
  };
}

export const KNOWN_ADAPTERS: readonly RuntimeAdapter[] = [
  makeAdapter('claude', 'claude', {
    streamJson: true,
    structuredOutput: true,
    mcpTools: true,
  }),
  makeAdapter('codex', 'codex', {
    streamJson: true,
    structuredOutput: false,
    mcpTools: false,
  }),
  makeAdapter('gemini', 'gemini', {
    streamJson: false,
    structuredOutput: false,
    mcpTools: false,
  }),
];

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Return a RuntimeAdapter for a known cliCommand.
 * Throws an Error for any unrecognised command string.
 */
export function createRuntimeAdapter(cliCommand: string): RuntimeAdapter {
  const adapter = KNOWN_ADAPTERS.find((a) => a.cliCommand === cliCommand);
  if (adapter === undefined) {
    throw new Error(
      `Unknown cliCommand: "${cliCommand}". Known commands: ${KNOWN_CLI_COMMANDS.join(', ')}`,
    );
  }
  return adapter;
}

/**
 * Detect all runtime CLIs that are currently available on PATH.
 *
 * Shells out `<cmd> --version` for every known CLI (claude, codex, gemini).
 * Results are cached in-process for 60 seconds so repeated calls within the
 * same TTL window are free.
 *
 * Returns an empty array — never throws — when no CLIs are found.
 */
export async function detectAvailableRuntimes(): Promise<DetectedRuntime[]> {
  const results: DetectedRuntime[] = [];
  for (const adapter of KNOWN_ADAPTERS) {
    const version = await detectVersionCached(adapter.cliCommand);
    if (version !== null) {
      results.push({ adapter, version });
    }
  }
  return results;
}
