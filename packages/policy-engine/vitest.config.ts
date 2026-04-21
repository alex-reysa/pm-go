import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Workspace packages publish `exports["."].import` pointing at `dist/`,
// which is not produced by `pnpm test` alone. Alias `@pm-go/contracts`
// to its TypeScript source so Vitest can resolve it without a build
// step. Mirrors the pattern in packages/planner/vitest.config.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@pm-go/contracts": fileURLToPath(
        new URL("../contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
