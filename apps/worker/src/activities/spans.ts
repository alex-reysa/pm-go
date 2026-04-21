import type { Span, UUID } from "@pm-go/contracts";
import type { PmGoDb } from "@pm-go/db";
import { createSpanWriter } from "@pm-go/observability";

/**
 * Phase 7 (Worker 4) — span persistence activity.
 *
 * `withSpan` is the primary persistence path; almost every wrapped
 * activity already gets its span row written for free by the sink that
 * the wrapper constructs. This activity exists for the minority case
 * where the open and close of a span happen in different processes
 * (e.g. the API records the span open at request time, the worker
 * closes it later). The API surface is allowed to call this directly
 * via Temporal because it never imports `@anthropic-ai/claude-agent-sdk`.
 *
 * Emission is best-effort: a failed insert is logged + swallowed (the
 * sink swallows). Workflows must not roll back on a span persistence
 * miss.
 */
export interface SpanActivityDeps {
  db: PmGoDb;
}

export function createSpanActivities(deps: SpanActivityDeps) {
  const { db } = deps;

  return {
    async persistSpan(input: { planId: UUID; span: Span }): Promise<void> {
      const writer = createSpanWriter({ db, planId: input.planId });
      await writer.writeSpan(input.span);
    },
  };
}
