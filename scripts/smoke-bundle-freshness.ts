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
  startToCloseTimeout: string;
}

interface Mismatch {
  workflowFile: string;
  symbolicName: string;
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
  while ((match = proxyRegex.exec(body)) !== null) {
    const ifaceName = match[1]!.trim();
    const optionsBlock = match[2]!;
    const timeoutMatch = optionsBlock.match(
      /startToCloseTimeout\s*:\s*["']([^"']+)["']/,
    );
    if (!timeoutMatch) continue;
    out.push({
      workflowFile: file,
      symbolicName: ifaceName,
      startToCloseTimeout: timeoutMatch[1]!,
    });
  }
  return out;
}

/**
 * Look for the same timeout literal inside the compiled JS file. The
 * tsc output preserves quoted string literals verbatim, so a substring
 * search on the dist file is a valid (and very fast) freshness check.
 */
function checkDistFor(source: SourceTimeout): Mismatch | null {
  const rel = relative(SOURCE_ROOT, source.workflowFile);
  const distRel = rel.replace(/\.ts$/, ".js");
  const distPath = join(DIST_ROOT, distRel);

  if (!existsSync(distPath)) {
    return {
      workflowFile: source.workflowFile,
      symbolicName: source.symbolicName,
      source: source.startToCloseTimeout,
      dist: null,
    };
  }

  const dist = readFileSync(distPath, "utf8");
  const distTimeoutMatch = dist.match(
    /startToCloseTimeout\s*:\s*["']([^"']+)["']/,
  );
  const observedDist = distTimeoutMatch ? distTimeoutMatch[1]! : null;

  if (observedDist === source.startToCloseTimeout) return null;

  return {
    workflowFile: source.workflowFile,
    symbolicName: source.symbolicName,
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

  const mismatches: Mismatch[] = [];
  for (const t of allTimeouts) {
    const m = checkDistFor(t);
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
      console.log(`  - ${rel} (${t.symbolicName}): ${t.startToCloseTimeout}`);
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
      `  - ${rel} (${m.symbolicName}):\n` +
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
