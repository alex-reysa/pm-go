import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const packagesDir = path.resolve(__dirname, "..");

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their TypeScript source since dist/
      // is not built in test runs. Each alias maps the package name to the
      // top-level source entry so Vite can transpile it via esbuild.
      "@pm-go/executor-claude": path.resolve(
        packagesDir,
        "executor-claude/src/index.ts",
      ),
      "@pm-go/contracts": path.resolve(packagesDir, "contracts/src/index.ts"),
    },
  },
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
