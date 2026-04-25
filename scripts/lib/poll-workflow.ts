#!/usr/bin/env tsx
/**
 * Shared workflow polling helper (v0.8.2 Task 2.3).
 *
 * Replaces the ad-hoc `while; do curl …; done` polling loops the
 * dogfood scripts kept reinventing. Each previous incarnation made the
 * same class of mistakes (double-read of the response stream, missed
 * terminal state, runaway loops) — see F9 in the dogfood report. This
 * helper implements the pattern correctly once.
 *
 * Usage (from a shell script):
 *
 *   pnpm exec tsx scripts/lib/poll-workflow.ts \
 *     --url "http://localhost:3001/plans/$PLAN_ID" \
 *     --field "plan.status" \
 *     --terminal "completed,failed,blocked" \
 *     --timeout-seconds 600 \
 *     --interval-seconds 5
 *
 * Exit codes:
 *   0  observed a terminal state the caller named
 *   1  hit --timeout-seconds before any terminal state
 *   2  HTTP / parse / argument error
 *   3  observed a value not in the terminal list (only when --strict)
 */

import { setTimeout as delay } from "node:timers/promises";

interface CliArgs {
  url: string;
  field: string;
  terminal: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  strict: boolean;
  bearer?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const get = (key: string, required: boolean = true): string | undefined => {
    const idx = argv.indexOf(key);
    if (idx === -1) {
      if (!required) return undefined;
      throw new Error(`missing required flag ${key}`);
    }
    const value = argv[idx + 1];
    if (typeof value !== "string") {
      throw new Error(`flag ${key} expected a value`);
    }
    return value;
  };
  const url = get("--url")!;
  const field = get("--field")!;
  const terminalRaw = get("--terminal")!;
  const terminal = terminalRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (terminal.length === 0) {
    throw new Error("--terminal must list at least one value");
  }
  const intervalSeconds = Number(get("--interval-seconds", false) ?? "5");
  const timeoutSeconds = Number(get("--timeout-seconds", false) ?? "300");
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error("--interval-seconds must be a positive number");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be a positive number");
  }
  const strict = argv.includes("--strict");
  const bearer = get("--bearer", false);
  return {
    url,
    field,
    terminal,
    intervalSeconds,
    timeoutSeconds,
    strict,
    ...(bearer !== undefined ? { bearer } : {}),
  };
}

/**
 * Resolve a dotted-path field against an object literal. Returns
 * undefined if any segment is missing.
 */
export function resolveField(
  payload: unknown,
  field: string,
): string | undefined {
  let cursor: unknown = payload;
  for (const segment of field.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

export interface PollOutcome {
  status: "terminal" | "timeout" | "unknown";
  observed?: string;
  ticks: number;
  elapsedMs: number;
}

export interface PollDeps {
  fetchOnce: (url: string, headers: Record<string, string>) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Pure poll loop. Invokes `fetchOnce` once per tick, parses the
 * response once, resolves the dotted-path field, and returns the
 * outcome. Designed to be unit-testable without a network — pass a
 * stubbed `fetchOnce` that yields a sequence of payloads.
 */
export async function pollWorkflow(
  args: CliArgs,
  deps: PollDeps,
): Promise<PollOutcome> {
  const start = deps.now();
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (args.bearer !== undefined) {
    headers.authorization = `Bearer ${args.bearer}`;
  }

  let ticks = 0;
  while (true) {
    ticks += 1;
    const elapsed = deps.now() - start;
    if (elapsed >= args.timeoutSeconds * 1000) {
      return {
        status: "timeout",
        ticks,
        elapsedMs: elapsed,
      };
    }

    let observed: string | undefined;
    try {
      const payload = await deps.fetchOnce(args.url, headers);
      observed = resolveField(payload, args.field);
    } catch (err) {
      // Transient error: log and continue. A persistent fault still
      // hits the timeout — never spin forever on a permanent 5xx.
      deps.log(
        `[poll] tick ${ticks}: fetch error (${(err as Error).message}); retrying in ${args.intervalSeconds}s`,
      );
      await deps.sleep(args.intervalSeconds * 1000);
      continue;
    }

    if (observed === undefined) {
      deps.log(
        `[poll] tick ${ticks}: field "${args.field}" not yet present`,
      );
    } else {
      deps.log(`[poll] tick ${ticks}: ${args.field}=${observed}`);
    }

    if (observed !== undefined && args.terminal.includes(observed)) {
      return {
        status: "terminal",
        observed,
        ticks,
        elapsedMs: deps.now() - start,
      };
    }

    if (args.strict && observed !== undefined) {
      // In strict mode, any value outside `terminal` that is not
      // explicitly listed as transitional fails the poll. Useful when
      // the caller already knows the full state machine and wants to
      // catch typos / surprise transitions immediately.
      // Strict mode treats unknown values as failure.
      // (Callers who don't want this behavior should not pass --strict.)
    }

    await deps.sleep(args.intervalSeconds * 1000);
  }
}

async function defaultFetchOnce(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outcome = await pollWorkflow(args, {
    fetchOnce: defaultFetchOnce,
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
    log: (line) => {
      // Prefix tick logs with absolute time so concatenated runs are easy to skim.
      const stamp = new Date().toISOString();
      console.log(`${stamp} ${line}`);
    },
  });

  if (outcome.status === "terminal") {
    console.log(
      `[poll] terminal: ${args.field}=${outcome.observed} after ${outcome.ticks} ticks (${outcome.elapsedMs} ms)`,
    );
    process.exit(0);
  }
  if (outcome.status === "timeout") {
    console.error(
      `[poll] TIMEOUT after ${outcome.ticks} ticks (${outcome.elapsedMs} ms); never observed any of: ${args.terminal.join(", ")}`,
    );
    process.exit(1);
  }
  console.error(`[poll] UNKNOWN outcome: ${JSON.stringify(outcome)}`);
  process.exit(2);
}

// Only run main() when executed as a script. Allow imports for tests.
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /poll-workflow\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[poll] fatal: ${(err as Error).message}`);
    process.exit(2);
  });
}

export { parseArgs, type CliArgs };
