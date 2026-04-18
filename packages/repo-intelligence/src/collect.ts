import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { RepoSnapshot } from "@pm-go/contracts";

import {
  detectPackageManager,
  deriveBuildCommand,
  deriveTestCommand,
  type PackageManager,
} from "./detect-commands.js";
import { RepoIntelligenceError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface CollectRepoSnapshotInput {
  repoRoot: string;
  /**
   * If provided, used verbatim as the snapshot id; otherwise a new UUID is generated.
   * Useful for deterministic test fixtures.
   */
  id?: string;
}

interface PackageJsonShape {
  repository?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

const FRAMEWORK_HINTS: Readonly<Record<string, string>> = {
  next: "Next.js",
  react: "React",
  hono: "Hono",
  "@hono/node-server": "Hono",
  fastify: "Fastify",
  express: "Express",
  "drizzle-orm": "Drizzle",
  prisma: "Prisma",
  "@temporalio/worker": "Temporal",
  "@temporalio/client": "Temporal",
  "@anthropic-ai/claude-agent-sdk": "Claude Agent SDK",
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepoRoot(repoRoot: string): Promise<boolean> {
  // `.git` may be a directory (normal clones) OR a file (worktrees), so a
  // plain existence check is the right signal here.
  return pathExists(join(repoRoot, ".git"));
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
    return stdout.trim();
  } catch (cause) {
    throw new RepoIntelligenceError(
      "git-command-failed",
      `git ${args.join(" ")} failed in ${repoRoot}`,
      { cause },
    );
  }
}

async function tryRunGit(repoRoot: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  const symRef = await tryRunGit(repoRoot, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (symRef) {
    const prefix = "refs/remotes/origin/";
    if (symRef.startsWith(prefix)) return symRef.slice(prefix.length);
    // Some git versions may return a short form; return as-is if no prefix.
    return symRef;
  }

  const head = await tryRunGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head === "main" || head === "master") return head;

  return "main";
}

async function readPackageJson(
  path: string,
): Promise<PackageJsonShape | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as PackageJsonShape;
  } catch (cause) {
    throw new RepoIntelligenceError(
      "malformed-package-json",
      `Failed to parse ${path}`,
      { cause },
    );
  }
}

function normalizeRepoUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const obj = input as { url?: unknown };
    if (typeof obj.url === "string") {
      // Normalize common forms like "git+https://github.com/foo/bar.git"
      // to a plain https URL when trivially possible.
      let url = obj.url;
      if (url.startsWith("git+")) url = url.slice(4);
      if (url.endsWith(".git")) url = url.slice(0, -4);
      return url;
    }
  }
  return undefined;
}

function collectFrameworkHintsFromPkg(
  pkg: PackageJsonShape | undefined,
  out: Set<string>,
): void {
  if (!pkg) return;
  const pools: Array<Record<string, unknown> | undefined> = [
    pkg.dependencies,
    pkg.devDependencies,
  ];
  for (const pool of pools) {
    if (!pool) continue;
    for (const name of Object.keys(pool)) {
      const hint = FRAMEWORK_HINTS[name];
      if (hint) out.add(hint);
    }
  }
}

async function readPnpmWorkspaceGlobs(repoRoot: string): Promise<string[]> {
  const yamlPath = join(repoRoot, "pnpm-workspace.yaml");
  let raw: string;
  try {
    raw = await readFile(yamlPath, "utf8");
  } catch {
    return [];
  }
  // Minimal YAML parsing: we only need the list items under `packages:`.
  // Keeping this dependency-free per charter constraints.
  const lines = raw.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^packages\s*:/i.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = /^\s*-\s*["']?([^"']+?)["']?\s*$/.exec(line);
      if (m && m[1]) {
        globs.push(m[1]);
      } else if (/^\S/.test(line)) {
        // Moved on to a new top-level key.
        inPackages = false;
      }
    }
  }
  return globs;
}

async function expandWorkspaceGlob(
  repoRoot: string,
  globPattern: string,
): Promise<string[]> {
  // Only supports the `<dir>/*` pattern (one wildcard segment), which is
  // what pm-go's workspace uses. Anything else returns empty — it's just
  // a hint source, not a correctness boundary.
  const parts = globPattern.split("/");
  if (parts.length !== 2 || parts[1] !== "*") return [];
  const base = parts[0];
  if (!base) return [];
  const baseDir = join(repoRoot, base);
  let entries: Dirent[];
  try {
    entries = (await readdir(baseDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(baseDir, e.name));
}

async function collectWorkspaceFrameworkHints(
  repoRoot: string,
  out: Set<string>,
): Promise<void> {
  const globs = await readPnpmWorkspaceGlobs(repoRoot);
  for (const g of globs) {
    const dirs = await expandWorkspaceGlob(repoRoot, g);
    for (const dir of dirs) {
      const pkg = await readPackageJson(join(dir, "package.json"));
      collectFrameworkHintsFromPkg(pkg, out);
    }
  }
}

async function findCiConfigPaths(repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, ".github", "workflows");
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return [];
  }
  const matched: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      matched.push(join(".github", "workflows", name));
    }
  }
  matched.sort();
  return matched;
}

export async function collectRepoSnapshot(
  input: CollectRepoSnapshotInput,
): Promise<RepoSnapshot> {
  const repoRoot = isAbsolute(input.repoRoot)
    ? input.repoRoot
    : resolve(input.repoRoot);

  // Step 1: validate path is a directory.
  let rootStat;
  try {
    rootStat = await stat(repoRoot);
  } catch (cause) {
    throw new RepoIntelligenceError(
      "not-a-directory",
      `Path does not exist: ${repoRoot}`,
      { cause },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new RepoIntelligenceError(
      "not-a-directory",
      `Path is not a directory: ${repoRoot}`,
    );
  }

  // Step 2: must be a git repo.
  if (!(await isGitRepoRoot(repoRoot))) {
    throw new RepoIntelligenceError(
      "not-a-git-repo",
      `Not a git repository (no .git entry): ${repoRoot}`,
    );
  }

  // Step 3: headSha.
  const headSha = await runGit(repoRoot, ["rev-parse", "HEAD"]);

  // Step 4: default branch.
  const defaultBranch = await resolveDefaultBranch(repoRoot);

  // Step 5: read root package.json + derive commands, languages, frameworks.
  const pkg = await readPackageJson(join(repoRoot, "package.json"));
  const pm: PackageManager = detectPackageManager(repoRoot);

  const scripts = (pkg?.scripts ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const buildCmd = deriveBuildCommand(scripts, pm);
  const testCmd = deriveTestCommand(scripts, pm);

  const buildCommands = buildCmd ? [buildCmd] : [];
  const testCommands = testCmd ? [testCmd] : [];

  // TypeScript signal: prefer root `tsconfig.json`; also accept
  // `tsconfig.base.json`, which is the idiomatic marker for monorepos that
  // keep only a base config at the root and per-package tsconfigs.
  const hasTsConfig =
    (await pathExists(join(repoRoot, "tsconfig.json"))) ||
    (await pathExists(join(repoRoot, "tsconfig.base.json")));
  const languageHints: string[] = hasTsConfig
    ? ["TypeScript"]
    : pkg
      ? ["JavaScript"]
      : [];

  const frameworkSet = new Set<string>();
  collectFrameworkHintsFromPkg(pkg, frameworkSet);
  // Monorepo-aware pass: workspace sub-packages often hold the actual
  // framework deps. This keeps detection useful for pnpm workspaces.
  await collectWorkspaceFrameworkHints(repoRoot, frameworkSet);
  const frameworkHints = Array.from(frameworkSet);

  // Step 6: CI config paths.
  const ciConfigPaths = await findCiConfigPaths(repoRoot);

  // Step 7/8: metadata.
  const capturedAt = new Date().toISOString();
  const id = input.id ?? randomUUID();

  const repoUrl = normalizeRepoUrl(pkg?.repository);

  const snapshot: RepoSnapshot = {
    id,
    repoRoot,
    ...(repoUrl ? { repoUrl } : {}),
    defaultBranch,
    headSha,
    languageHints,
    frameworkHints,
    buildCommands,
    testCommands,
    ciConfigPaths,
    capturedAt,
  };
  return snapshot;
}
