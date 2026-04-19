import type { Config } from "drizzle-kit";

export default {
  schema: [
    "./packages/db/src/schema/spec-documents.ts",
    "./packages/db/src/schema/repo-snapshots.ts",
    "./packages/db/src/schema/plans.ts",
    "./packages/db/src/schema/phases.ts",
    "./packages/db/src/schema/plan-tasks.ts",
    "./packages/db/src/schema/task-dependencies.ts",
    "./packages/db/src/schema/agent-runs.ts",
    "./packages/db/src/schema/artifacts.ts",
    "./packages/db/src/schema/worktree-leases.ts",
  ],
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env["DATABASE_URL"] ??
      "postgres://pmgo:pmgo@localhost:5432/pm_go",
  },
  casing: "snake_case",
} satisfies Config;
