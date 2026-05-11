-- Bug #14: Add merge_runs.failure_reason
--
-- Before this column, a failed PhaseIntegrationWorkflow merge_run row
-- captured only `failed_task_id`. The validation logs returned by the
-- `validatePostMergeState` activity were discarded by the workflow, so
-- operators could not tell whether the failure was `pnpm install`,
-- `pnpm -r build`, a per-task testCommand, or the post-step git reset.
--
-- `failure_reason` stores the trailing chunk (last failed step + tail)
-- of those captured logs. NULL on a successful run — we don't bloat
-- happy-path rows with multi-MB pnpm output. The column is plain TEXT
-- so any existing API endpoint that selects merge_runs picks it up
-- without a new GET surface.

ALTER TABLE "merge_runs" ADD COLUMN "failure_reason" text;
