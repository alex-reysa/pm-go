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
    "./packages/db/src/schema/review-reports.ts",
    "./packages/db/src/schema/policy-decisions.ts",
    "./packages/db/src/schema/merge-runs.ts",
    "./packages/db/src/schema/phase-audit-reports.ts",
    "./packages/db/src/schema/completion-audit-reports.ts",
    "./packages/db/src/schema/workflow-events.ts",
    // Phase 7 (Worker 1) — additive durable tables. Registered here so
    // `pnpm db:generate` regenerates Drizzle snapshots that include
    // approval_requests + budget_reports alongside the trace columns
    // added to workflow_events by migration 0012.
    "./packages/db/src/schema/approval-requests.ts",
    "./packages/db/src/schema/budget-reports.ts",
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
