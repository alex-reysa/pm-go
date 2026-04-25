-- v0.8.2.1 P1.4: extend the artifact_kind enum with `runner_diagnostic`
-- so the worker can persist a forensic record when a Claude-backed
-- runner's structured_output payload fails runtime schema validation.
-- Mirrors the existing artifact-row + on-disk-content pattern used for
-- `plan_markdown` (apps/worker writes JSON under artifactDir, the row
-- in `artifacts` is just metadata pointing at the file).

ALTER TYPE "artifact_kind" ADD VALUE IF NOT EXISTS 'runner_diagnostic';
