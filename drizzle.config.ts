import type { Config } from "drizzle-kit";

export default {
  schema: [
    "./packages/db/src/schema/spec-documents.ts",
    "./packages/db/src/schema/repo-snapshots.ts",
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
