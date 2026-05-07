#!/usr/bin/env tsx
/**
 * Bundle freshness smoke (v0.8.2 Task 0.3).
 *
 * Symptom this catches: a stale `apps/worker/dist` or
 * `packages/temporal-workflows/dist` bundle keeps caching old
 * `proxyActivities` config — most famously a `startToCloseTimeout` that
 * lags behind source. The dogfood report (F1) burned 45 minutes on a 5m
 * vs 20m mismatch that every other signal claimed was fixed.
 *
 * Strategy: walk every `apps/worker/src/workflows/*.ts` file, extract
 * each `proxyActivities<...>({ startToCloseTimeout: "<value>", ... })`
 * literal, then read the corresponding compiled `apps/worker/dist/...`
 * artifact and assert the same literal is present. Because the worker
 * uses the dist tree at runtime, a mismatch here is exactly the class
 * of bug F1 describes.
 *
 * Pure static check — no Temporal connection needed. Designed to run in
 * well under 30 seconds on a warm local stack.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = join(REPO_ROOT, "apps/worker/src/workflows");
const DIST_ROOT = join(REPO_ROOT, "apps/worker/dist/workflows");

interface SourceTimeout {
  workflowFile: string;
  symbolicName: string;
  /**
   * 0-based ordinal of this `proxyActivities<IFACE>(...)` call within
   * the source file, used to pair against the same-positioned
   * `proxyActivities(...)` call in the compiled dist file. Required
   * because TypeScript erases the type-arg in dist, so two
   * `proxyActivities<SameInterface>(...)` calls in one file are
   * otherwise indistinguishable.
   */
  occurrenceIndex: number;
  startToCloseTimeout: string;
}

interface Mismatch {
  workflowFile: string;
  symbolicName: string;
  occurrenceIndex: number;
  source: string;
  dist: string | null;
}

function listTypescriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...listTypescriptFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Pull every `startToCloseTimeout: "<value>"` literal that appears
 * inside a `proxyActivities<...>({ ... })` call. Assigns each to a
 * stable symbolic name based on a hash of the surrounding interface
 * name when available, falling back to the literal string itself.
 */
function extractSourceTimeouts(file: string): SourceTimeout[] {
  const body = readFileSync(file, "utf8");
  const out: SourceTimeout[] = [];
  const proxyRegex =
    /proxyActivities<([^>]+)>\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let match: RegExpExecArray | null;
  let occurrenceIndex = 0;
  while ((match = proxyRegex.exec(body)) !== null) {
    const ifaceName = match[1]!.trim();
    const optionsBlock = match[2]!;
    const timeoutMatch = optionsBlock.match(
      /startToCloseTimeout\s*:\s*["']([^"']+)["']/,
    );
    if (!timeoutMatch) {
      occurrenceIndex += 1;
      continue;
    }
    out.push({
      workflowFile: file,
      symbolicName: ifaceName,
      occurrenceIndex,
      startToCloseTimeout: timeoutMatch[1]!,
    });
    occurrenceIndex += 1;
  }
  return out;
}

/**
 * Pull the timeout literal from each `proxyActivities({...})` call in a
 * compiled dist file, indexed by 0-based occurrence order. TypeScript
 * erases the `<IFACE>` type-arg in dist, so we cannot match by interface
 * name; we have to match by call position instead. Returns one entry
 * per `proxyActivities(...)` call (including ones that don't declare a
 * timeout — those map to `null` so the caller can still report the
 * pairing as a mismatch rather than silently skipping).
 */
function extractDistTimeouts(distBody: string): Array<string | null> {
  const proxyRegex = /proxyActivities\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  const out: Array<string | null> = [];
  let match: RegExpExecArray | null;
  while ((match = proxyRegex.exec(distBody)) !== null) {
    const optionsBlock = match[1]!;
    const timeoutMatch = optionsBlock.match(
      /startToCloseTimeout\s*:\s*["']([^"']+)["']/,
    );
    out.push(timeoutMatch ? timeoutMatch[1]! : null);
  }
  return out;
}

/**
 * Look for the same timeout literal inside the compiled JS file at the
 * matching `proxyActivities(...)` call position. The tsc output
 * preserves quoted string literals verbatim, so a position-paired
 * lookup against the dist file is a valid (and very fast) freshness
 * check. The pairing-by-occurrence is required because two
 * `proxyActivities<SameInterface>(...)` calls in one file (e.g.
 * spec-decomposition.ts) collapse to two indistinguishable
 * `proxyActivities({...})` calls in dist after type-arg erasure.
 */
function checkDistFor(
  source: SourceTimeout,
  distTimeoutsByPath: Map<string, Array<string | null> | null>,
): Mismatch | null {
  const rel = relative(SOURCE_ROOT, source.workflowFile);
  const distRel = rel.replace(/\.ts$/, ".js");
  const distPath = join(DIST_ROOT, distRel);

  let distTimeouts = distTimeoutsByPath.get(distPath);
  if (distTimeouts === undefined) {
    if (!existsSync(distPath)) {
      distTimeouts = null;
    } else {
      const distBody = readFileSync(distPath, "utf8");
      distTimeouts = extractDistTimeouts(distBody);
    }
    distTimeoutsByPath.set(distPath, distTimeouts);
  }

  if (distTimeouts === null) {
    return {
      workflowFile: source.workflowFile,
      symbolicName: source.symbolicName,
      occurrenceIndex: source.occurrenceIndex,
      source: source.startToCloseTimeout,
      dist: null,
    };
  }

  const observedDist = distTimeouts[source.occurrenceIndex] ?? null;

  if (observedDist === source.startToCloseTimeout) return null;

  return {
    workflowFile: source.workflowFile,
    symbolicName: source.symbolicName,
    occurrenceIndex: source.occurrenceIndex,
    source: source.startToCloseTimeout,
    dist: observedDist,
  };
}

function main(): number {
  const start = Date.now();
  const sourceFiles = listTypescriptFiles(SOURCE_ROOT);
  if (sourceFiles.length === 0) {
    console.error(
      `[bundle-freshness] No source files found under ${SOURCE_ROOT}. ` +
        "Did you point this at the wrong repo?",
    );
    return 2;
  }

  const allTimeouts: SourceTimeout[] = [];
  for (const file of sourceFiles) {
    allTimeouts.push(...extractSourceTimeouts(file));
  }

  if (allTimeouts.length === 0) {
    console.error(
      "[bundle-freshness] Found zero `startToCloseTimeout` literals in source. " +
        "This script can't validate bundle freshness without source declarations.",
    );
    return 2;
  }

  const distTimeoutsByPath = new Map<string, Array<string | null> | null>();
  const mismatches: Mismatch[] = [];
  for (const t of allTimeouts) {
    const m = checkDistFor(t, distTimeoutsByPath);
    if (m) mismatches.push(m);
  }

  const elapsedMs = Date.now() - start;

  if (mismatches.length === 0) {
    console.log(
      `[bundle-freshness] OK — ${allTimeouts.length} startToCloseTimeout ` +
        `declarations match between source and dist (${elapsedMs} ms).`,
    );
    for (const t of allTimeouts) {
      const rel = relative(REPO_ROOT, t.workflowFile);
      console.log(
        `  - ${rel} (${t.symbolicName}#${t.occurrenceIndex}): ` +
          `${t.startToCloseTimeout}`,
      );
    }
    return 0;
  }

  console.error(
    `[bundle-freshness] FAIL — ${mismatches.length} of ${allTimeouts.length} ` +
      "timeouts disagree between source and dist.",
  );
  for (const m of mismatches) {
    const rel = relative(REPO_ROOT, m.workflowFile);
    console.error(
      `  - ${rel} (${m.symbolicName}#${m.occurrenceIndex}):\n` +
        `      source expected: ${m.source}\n` +
        `      dist observed:   ${m.dist ?? "<missing dist file>"}`,
    );
  }
  console.error(
    "\nFix: rm -rf apps/worker/dist packages/temporal-workflows/dist && pnpm -r build",
  );
  return 1;
}

const code = main();
process.exit(code);
