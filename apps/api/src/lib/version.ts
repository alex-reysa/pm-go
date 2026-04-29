import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Read `apps/api/package.json` once at module load and surface the
 * `@pm-go/api` package version. Mirrors the `defaultRepoRoot` pattern
 * in `index.ts`: derive the path from `import.meta.url` so the lookup
 * does not depend on `process.cwd()` and works under both `tsx` and
 * the compiled `dist/` build.
 *
 * The cost is paid exactly once on module load. The `/health` route
 * closure imports {@link apiVersion} directly, so no per-request I/O
 * is incurred.
 *
 * Tests that need to verify the read logic against a synthetic
 * `package.json` should call {@link readApiVersionWith} with a
 * stubbed reader rather than mutate the cached value.
 */

/** A reader that returns the contents of `apps/api/package.json` as a UTF-8 string. */
export type PackageJsonReader = () => string;

/**
 * Absolute path to `apps/api/package.json`. Computed at module load
 * from `import.meta.url`; the version module lives at
 * `apps/api/src/lib/version.ts` (compiled: `apps/api/dist/lib/version.js`),
 * and `package.json` is two directories up (`../../package.json`).
 */
const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);

const defaultReader: PackageJsonReader = () =>
  readFileSync(packageJsonPath, "utf8");

function parseVersion(raw: string): string {
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(
      "@pm-go/api package.json is missing a non-empty 'version' string",
    );
  }
  return parsed.version;
}

/**
 * Test seam: read the version using a caller-supplied reader. Lets
 * unit tests verify the reading logic against a synthetic
 * `package.json` body without touching the on-disk file or the
 * cached {@link apiVersion}.
 */
export function readApiVersionWith(reader: PackageJsonReader): string {
  return parseVersion(reader());
}

/**
 * The `@pm-go/api` package version, read from `apps/api/package.json`
 * exactly once at module load.
 */
export const apiVersion: string = parseVersion(defaultReader());
