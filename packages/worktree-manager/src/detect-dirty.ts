import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DirtyReport } from "./types.js";

const execFileAsync = promisify(execFile);

export interface DetectDirtyInput {
  worktreePath: string;
}

/**
 * Classify the working-tree state of `worktreePath` into untracked vs
 * modified files. The dirty-worktree policy escalates rather than
 * auto-cleans, so callers need the per-file breakdown to include in the
 * escalation payload.
 *
 * Uses `--porcelain=v2` for a stable, line-oriented format:
 *   - `? <path>`                 — untracked
 *   - `1 <xy> ... <path>`        — changed single-file entry
 *   - `2 <xy> ... <orig> <path>` — renamed/copied entry (from-path TAB to-path)
 *
 * Ignored files (`!`) and merge-unresolved entries (`u`) are not
 * reported — the former intentionally so, the latter because V1 never
 * runs inside a merge.
 */
export async function detectDirty(
  input: DetectDirtyInput,
): Promise<DirtyReport> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    input.worktreePath,
    "status",
    "--porcelain=v2",
  ]);

  const unknownFiles: string[] = [];
  const modifiedFiles: string[] = [];

  // `--porcelain=v2` uses LF separators; rename/copy entries embed a tab
  // between the original and new paths but each entry still lives on a
  // single line.
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("? ")) {
      unknownFiles.push(line.slice(2));
      continue;
    }
    if (line.startsWith("1 ")) {
      modifiedFiles.push(parseChangedPath(line));
      continue;
    }
    if (line.startsWith("2 ")) {
      // Rename/copy: the new path is whatever follows the last TAB on
      // the line. Record the new path since it's the one now present
      // on disk.
      const tabIndex = line.indexOf("\t");
      const after = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
      const renamedNew = tabIndex >= 0 ? line.slice(tabIndex + 1) : "";
      modifiedFiles.push(renamedNew || parseChangedPath(after));
      continue;
    }
  }

  return {
    dirty: unknownFiles.length + modifiedFiles.length > 0,
    unknownFiles,
    modifiedFiles,
  };
}

/**
 * Extract the repo-relative path from a `1 ...` status line. The format
 * is: `1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — eight
 * space-separated header fields followed by the path, which itself may
 * contain spaces. So we skip the first eight tokens and keep the rest.
 */
function parseChangedPath(line: string): string {
  // Skip the leading "1 " prefix, then the remaining 7 header tokens.
  let idx = 2; // past "1 "
  for (let tok = 0; tok < 7; tok++) {
    const next = line.indexOf(" ", idx);
    if (next < 0) return line.slice(idx);
    idx = next + 1;
  }
  return line.slice(idx);
}
