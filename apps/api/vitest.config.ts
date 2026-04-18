import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@pm-go/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
});
