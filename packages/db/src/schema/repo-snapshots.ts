import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";

export const repoSnapshots = pgTable("repo_snapshots", {
  id: uuid("id").primaryKey(),
  repoRoot: text("repo_root").notNull(),
  repoUrl: text("repo_url"),
  defaultBranch: text("default_branch").notNull(),
  headSha: text("head_sha").notNull(),
  languageHints: text("language_hints").array().notNull(),
  frameworkHints: text("framework_hints").array().notNull(),
  buildCommands: text("build_commands").array().notNull(),
  testCommands: text("test_commands").array().notNull(),
  ciConfigPaths: text("ci_config_paths").array().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export type RepoSnapshotRow = typeof repoSnapshots.$inferSelect;
export type RepoSnapshotInsert = typeof repoSnapshots.$inferInsert;
