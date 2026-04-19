import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FileScope } from "@pm-go/contracts";

import type { DiffScopeResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface DiffScopeInput {
  worktreePath: string;
  baseSha: string;
  fileScope: FileScope;
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

  const violations: string[] = [];
  for (const file of changedFiles) {
    if (!isInScope(file, fileScope)) {
      violations.push(file);
    }
  }

  return {
    changedFiles,
    violations,
    fileScope,
  };
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
