import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Create a fresh temporary git repository with a single seed commit.
 *
 * The repo lives under `tmpdir()` and its `user.email`/`user.name`
 * are configured locally so `git commit` succeeds regardless of the
 * machine's global git identity. Callers must invoke the returned
 * `cleanup()` to remove the directory when the test finishes.
 */
export async function createTempGitRepo(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pm-go-wt-"));
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@pm-go.dev"], { cwd: dir });
  await exec("git", ["config", "user.name", "test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "seed\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-m", "seed"], { cwd: dir });
  return {
    path: dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
