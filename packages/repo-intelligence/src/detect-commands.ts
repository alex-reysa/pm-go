import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "npm" | "yarn";

/**
 * Determine the package manager used by the repo by inspecting its lockfiles.
 * Precedence: pnpm-lock.yaml > package-lock.json > yarn.lock > default "pnpm".
 */
export function detectPackageManager(repoRoot: string): PackageManager {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "pnpm";
}

/**
 * Build command string, derived from `package.json#scripts.build` and the
 * detected package manager. Returns undefined when no build script exists.
 */
export function deriveBuildCommand(
  scripts: Record<string, unknown> | undefined,
  pm: PackageManager,
): string | undefined {
  if (scripts && typeof scripts.build === "string") {
    return `${pm} build`;
  }
  return undefined;
}

/**
 * Test command string, derived from `package.json#scripts.test` and the
 * detected package manager. Returns undefined when no test script exists.
 */
export function deriveTestCommand(
  scripts: Record<string, unknown> | undefined,
  pm: PackageManager,
): string | undefined {
  if (scripts && typeof scripts.test === "string") {
    return `${pm} test`;
  }
  return undefined;
}
