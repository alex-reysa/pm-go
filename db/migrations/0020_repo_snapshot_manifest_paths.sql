ALTER TABLE "repo_snapshots" ADD COLUMN "manifest_paths" text[] DEFAULT '{}'::text[] NOT NULL;
