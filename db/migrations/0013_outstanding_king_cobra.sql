-- Track B: add `error_reason` to `agent_runs` so classified SDK
-- failures (see `@pm-go/executor-claude`'s `ExecutorError.errorReason`)
-- land on the durable row. Paired with the `nonRetryableErrorNames`
-- entry for `ContentFilterError` in `PHASE7_RETRY_POLICIES` — the
-- column is operator-facing context for failed rows that the retry
-- policy now short-circuits.
ALTER TABLE "agent_runs" ADD COLUMN "error_reason" text;