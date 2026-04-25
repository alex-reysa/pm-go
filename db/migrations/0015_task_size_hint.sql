-- v0.8.2 Task 1.1: Add Task.sizeHint
--
-- The planner emits a size hint to feed the small-task fast path. NULL is
-- treated as "medium" everywhere downstream — existing rows do not need
-- a backfill, but new rows from the v0.8.2 planner will populate this.

CREATE TYPE "task_size_hint" AS ENUM ('small', 'medium', 'large');

ALTER TABLE "plan_tasks" ADD COLUMN "size_hint" "task_size_hint";
