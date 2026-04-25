import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FileScope } from "@pm-go/contracts";

import type { DiffScopeResult as _DiffScopeResult } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Extended result type that adds `scopeExpansions` — files that would
 * have been violations but were auto-allowed by a benign-expansion
 * predicate (see `allowBenignExpansion` on {@link DiffScopeInput}).
 */
export interface DiffScopeResult extends _DiffScopeResult {
  /**
   * Files that fell outside `fileScope` but were auto-approved by a
   * benign-expansion predicate. Not counted as violations.
   */
  scopeExpansions: string[];
}

export interface DiffScopeInput {
  worktreePath: string;
  baseSha: string;
  fileScope: FileScope;
  /**
   * When true, apply the three benign-expansion predicates before
   * classifying out-of-scope files as violations:
   *
   * 1. pnpm-lock.yaml is auto-allowed when the diff also adds at
   *    least one packages/<star>/package.json (newly added file).
   * 2. Root package.json is auto-allowed when the only structural diff
   *    adds a single key under scripts and touches no dependency keys
   *    (dependencies, devDependencies, peerDependencies,
   *    optionalDependencies).
   * 3. packages/<star>/vitest.config.ts is auto-allowed when the task
   *    also touches files under packages/<star>/src/** within its
   *    declared fileScope.
   *
   * Matched files are returned in scopeExpansions, not violations.
   */
  allowBenignExpansion?: boolean;
}

/**
 * Compute the set of files touched in the worktree (committed +
 * uncommitted + untracked) relative to `baseSha` and flag any entries
 * that fall outside `fileScope`.
 *
 * The diff is the *union* of three git views:
 *   1. `diff --name-only <baseSha> HEAD` — committed changes on the
 *      branch since the lease was taken.
 *   2. `diff --name-only HEAD`           — uncommitted tracked changes.
 *   3. `ls-files --others --exclude-standard` — new untracked files
 *      (ignored files are excluded via gitignore).
 *
 * The result is deduped and sorted so downstream consumers can diff
 * scope reports deterministically.
 */
export async function diffScope(
  input: DiffScopeInput,
): Promise<DiffScopeResult> {
  const { worktreePath, baseSha, fileScope } = input;

  const [committed, uncommitted, untracked] = await Promise.all([
    runLines(worktreePath, [
      "diff",
      "--name-only",
      baseSha,
      "HEAD",
    ]),
    runLines(worktreePath, ["diff", "--name-only", "HEAD"]),
    runLines(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  ]);

  const all = new Set<string>();
  for (const lst of [committed, uncommitted, untracked]) {
    for (const entry of lst) {
      if (entry.length > 0) all.add(entry);
    }
  }
  const changedFiles = Array.from(all).sort();

  // v0.8.2.1 P2.1: total lines added + removed across baseSha..HEAD plus
  // uncommitted edits. Feeds the small-task fast path's host guard so a
  // single 500-line file marked sizeHint=small cannot skip review based
  // on file count alone. Untracked files don't appear in `--numstat`
  // output, so we count their lines via wc-equivalent.
  const linesChanged = await computeLinesChanged({
    worktreePath,
    baseSha,
    untrackedFiles: untracked,
  });

  const violations: string[] = [];
  const scopeExpansions: string[] = [];

  if (input.allowBenignExpansion) {
    // Compute the set of newly-added files (not modified) for predicate 1.
    const addedCommitted = await runLines(worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=A",
      baseSha,
      "HEAD",
    ]);
    // Untracked files are inherently new.
    const addedFiles = new Set<string>([...addedCommitted, ...untracked]);

    for (const file of changedFiles) {
      if (!isInScope(file, fileScope)) {
        const benign = await isBenignExpansion(file, {
          worktreePath,
          baseSha,
          fileScope,
          changedFiles,
          addedFiles,
        });
        if (benign) {
          scopeExpansions.push(file);
        } else {
          violations.push(file);
        }
      }
    }
  } else {
    for (const file of changedFiles) {
      if (!isInScope(file, fileScope)) {
        violations.push(file);
      }
    }
  }

  return {
    changedFiles,
    violations,
    scopeExpansions,
    fileScope,
    linesChanged,
  };
}

/**
 * Compute total lines added + removed for the diff plus any untracked
 * files (counted as full-file additions). Returns 0 on git failure
 * rather than throwing — the caller may still proceed without the
 * line-count guard, just falling back to the file-count check.
 */
async function computeLinesChanged(args: {
  worktreePath: string;
  baseSha: string;
  untrackedFiles: string[];
}): Promise<number> {
  let total = 0;
  try {
    // `--numstat baseSha` covers committed + uncommitted (working tree)
    // diffs in one shot. Each line: <added>\t<removed>\t<path>; binary
    // files report `-\t-\t<path>`, which we skip.
    const { stdout } = await execFileAsync("git", [
      "-C",
      args.worktreePath,
      "diff",
      "--numstat",
      args.baseSha,
    ]);
    for (const raw of stdout.split("\n")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const [addedRaw, removedRaw] = trimmed.split("\t");
      if (!addedRaw || !removedRaw) continue;
      if (addedRaw === "-" || removedRaw === "-") continue;
      const added = Number(addedRaw);
      const removed = Number(removedRaw);
      if (Number.isFinite(added)) total += added;
      if (Number.isFinite(removed)) total += removed;
    }
  } catch {
    // Git failure → fall back to 0; caller can still use file-count.
    return 0;
  }
  // Untracked files: count their lines as additions (no `--` index
  // entry for them, so `git diff --numstat` skips them).
  for (const file of args.untrackedFiles) {
    try {
      const { stdout } = await execFileAsync("wc", ["-l", file], {
        cwd: args.worktreePath,
      });
      const m = stdout.trim().match(/^(\d+)/);
      if (m && m[1]) total += Number(m[1]);
    } catch {
      // best-effort; skip files we can't count
    }
  }
  return total;
}

interface BenignContext {
  worktreePath: string;
  baseSha: string;
  fileScope: FileScope;
  changedFiles: string[];
  addedFiles: Set<string>;
}

/**
 * Returns `true` if `file` matches one of the three benign-expansion
 * predicates.
 */
async function isBenignExpansion(
  file: string,
  ctx: BenignContext,
): Promise<boolean> {
  // Predicate 1 — pnpm-lock.yaml
  if (file === "pnpm-lock.yaml") {
    return Array.from(ctx.addedFiles).some((f) =>
      matchesPattern(f, "packages/*/package.json"),
    );
  }

  // Predicate 2 — root package.json: only a single scripts.* key added,
  // no dependency keys touched.
  if (file === "package.json") {
    return isScriptsOnlyDiff(ctx.worktreePath, ctx.baseSha);
  }

  // Predicate 3 — packages/*/vitest.config.ts: the task also has in-scope
  // changes under packages/<same-pkg>/src/**.
  if (matchesPattern(file, "packages/*/vitest.config.ts")) {
    const segments = file.split("/");
    const pkg = segments[1]; // e.g. "worktree-manager"
    if (pkg) {
      return ctx.changedFiles.some(
        (f) =>
          matchesPattern(f, `packages/${pkg}/src/**`) &&
          isInScope(f, ctx.fileScope),
      );
    }
  }

  return false;
}

/**
 * Returns `true` when the diff of `package.json` (root) between
 * `baseSha` and HEAD:
 *   - Adds exactly one key under `scripts` (one new `"name": "..."` entry).
 *   - Does NOT touch `dependencies`, `devDependencies`, `peerDependencies`,
 *     or `optionalDependencies` keys at the top level.
 *
 * Works on both committed changes and uncommitted ones by diffing
 * `baseSha` → working tree.
 */
async function isScriptsOnlyDiff(
  worktreePath: string,
  baseSha: string,
): Promise<boolean> {
  let diffText: string;
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      worktreePath,
      "diff",
      baseSha,
      "--",
      "package.json",
    ]);
    diffText = stdout;
  } catch {
    return false;
  }

  if (!diffText.trim()) return false;

  const DEP_KEYS = new Set([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]);

  // Count how many scripts entries were added (lines starting with +
  // that look like a JSON key inside a "scripts" block, e.g.
  // `+    "build": "tsc"`).
  //
  // We track nesting depth (not just a boolean) so that object-valued
  // script entries — or any context lines containing braces — don't
  // prematurely exit the "in scripts" state.  Depth 0 = outside any
  // top-level section; depth 1 = inside the scripts (or other) object;
  // depth > 1 = nested inside a scripts value.
  let inScripts = false;
  let nestDepth = 0;
  let scriptsAdded = 0;
  let scriptsRemoved = 0;
  let depTouched = false;

  for (const raw of diffText.split("\n")) {
    const line = raw;

    // Detect section headers in the diff (context lines that open a JSON
    // object key). We use simple heuristics — this is intentionally
    // conservative; if the diff looks unusual we return false.
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("@@")) {
      continue;
    }

    const content = line.slice(1); // strip the +/-/space prefix
    const trimmed = content.trim();

    // Check if this line opens a top-level key section (e.g.
    // `  "scripts": {` or `  "dependencies": {`).
    const sectionMatch = trimmed.match(/^"([^"]+)"\s*:\s*\{/);
    if (sectionMatch && nestDepth === 0) {
      const key = sectionMatch[1]!;
      inScripts = key === "scripts";
      nestDepth = 1;
      if (DEP_KEYS.has(key) && (line.startsWith("+") || line.startsWith("-"))) {
        depTouched = true;
      }
      continue;
    }

    // Track additional opening braces to handle nested objects inside a
    // scripts value (rare but possible in certain JSON layouts).
    if (nestDepth > 0 && trimmed.endsWith("{")) {
      nestDepth++;
      continue;
    }

    // Detect when we leave the current section: decrement on every closing
    // brace and reset inScripts only when we return to the top level.
    if (nestDepth > 0 && (trimmed === "}," || trimmed === "}")) {
      nestDepth--;
      if (nestDepth === 0) {
        inScripts = false;
      }
      continue;
    }

    if (inScripts) {
      // A script entry: `"name": "command"` — could be added or removed.
      if (line.startsWith("+") && trimmed.match(/^"[^"]+"\s*:/)) {
        scriptsAdded++;
      }
      if (line.startsWith("-") && trimmed.match(/^"[^"]+"\s*:/)) {
        scriptsRemoved++;
      }
    }

    // Also flag if any dep key appears in added/removed lines (belt-
    // and-suspenders in case they appear inline rather than as a section
    // header).
    if (line.startsWith("+") || line.startsWith("-")) {
      for (const key of DEP_KEYS) {
        if (trimmed.includes(`"${key}"`)) {
          depTouched = true;
        }
      }
    }
  }

  return !depTouched && scriptsAdded === 1 && scriptsRemoved === 0;
}

async function runLines(
  cwd: string,
  args: readonly string[],
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * True iff `file` is covered by `fileScope.includes` AND not excluded
 * by `fileScope.excludes`. Excludes take precedence over includes: a
 * path that matches both is treated as a violation, mirroring the
 * "blacklist wins" policy documented in git-and-worktree-policy.
 */
function isInScope(file: string, fileScope: FileScope): boolean {
  const excludes = fileScope.excludes ?? [];
  for (const pattern of excludes) {
    if (matchesPattern(file, pattern)) return false;
  }
  for (const pattern of fileScope.includes) {
    if (matchesPattern(file, pattern)) return true;
  }
  return false;
}

/**
 * Minimal glob matcher for repo-relative paths. Supports:
 *   - `**`  matches any number of path segments (including zero).
 *   - `*`   matches any characters within a single segment.
 *   - Anything else matches literally.
 *
 * Intentionally conservative: no bracket classes, no `?`, no brace
 * expansion. Exact-prefix include entries (e.g. `packages/contracts/src/
 * shared/schema.ts`) fall through as literal matches when no wildcard
 * is present.
 */
export function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return file === pattern;
  }
  const regex = compileGlob(pattern);
  return regex.test(file);
}

function compileGlob(pattern: string): RegExp {
  // Walk the pattern one character at a time and emit the regex source.
  // Escaping every regex metachar we don't rewrite keeps user patterns
  // safe even if they contain `.` or `+`.
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      // `**`   → match any sequence of characters (incl. `/`)
      // `**/`  → additionally allow the trailing slash to be empty so
      //          `src/**/foo` matches `src/foo`.
      if (pattern[i + 2] === "/") {
        src += "(?:.*/)?";
        i += 3;
      } else {
        src += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      // Single `*` → match anything inside a single segment.
      src += "[^/]*";
      i += 1;
      continue;
    }
    // Escape regex metacharacters.
    if (ch !== undefined && /[\\^$.|?+(){}\[\]]/.test(ch)) {
      src += `\\${ch}`;
    } else {
      src += ch;
    }
    i += 1;
  }
  return new RegExp(`^${src}$`);
}
