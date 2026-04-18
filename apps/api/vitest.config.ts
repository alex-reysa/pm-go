import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Workspace packages publish `exports["."].import` pointing at `dist/`,
// which is not produced by `pnpm test` alone. Alias the packages we
// consume from api tests to their TypeScript sources so Vitest can
// resolve them without a build step.
export default defineConfig({
  resolve: {
    alias: {
      "@pm-go/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@pm-go/db": fileURLToPath(
        new URL("../../packages/db/src/index.ts", import.meta.url),
      ),
      "@pm-go/planner": fileURLToPath(
        new URL("../../packages/planner/src/index.ts", import.meta.url),
      ),
      "@pm-go/executor-claude": fileURLToPath(
        new URL(
          "../../packages/executor-claude/src/index.ts",
          import.meta.url,
        ),
      ),
      "@pm-go/repo-intelligence": fileURLToPath(
        new URL(
          "../../packages/repo-intelligence/src/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
