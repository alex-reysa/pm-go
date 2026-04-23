import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@pm-go/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // ink renders asynchronously to a custom stream — under vitest's
    // default thread pool, concurrent tests interfere with each other's
    // frame timing, producing flaky "expected output to contain X"
    // failures that pass when the test runs in isolation. Use the
    // `forks` pool with single-fork execution so TUI tests see a clean
    // event loop each time.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
