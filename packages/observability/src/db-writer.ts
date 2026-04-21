import type { Span } from "@pm-go/contracts/observability";
import { workflowEvents, type PmGoDb } from "@pm-go/db";

import { newUuid } from "./ids.js";

/**
 * Phase 7 DB-backed span writer. Spans land as rows on
 * `workflow_events` with `kind='span_emitted'` and `trace_id` /
 * `span_id` populated from the span's correlation ids. The JSONB
 * `payload` carries the full `Span` contract shape so replay code
 * can reconstruct durations, attrs, and error messages without a
 * secondary table.
 *
 * Why not a dedicated `spans` table? Phase 7's sink requirement is
 * "every activity emits a correlated event". `workflow_events` is
 * already the operator-facing timeline — piggybacking on it means
 * the TUI event stream automatically shows spans with zero
 * additional wiring. A dedicated table is a Phase 8 option if span
 * volume ever exceeds workflow-event volume by a meaningful factor.
 *
 * Emission is best-effort: DB failures are logged and swallowed.
 * The observability layer must never roll back a successful activity.
 * This mirrors the Phase 6 `emitWorkflowEvent` contract.
 */

export interface SpanWriterDeps {
  db: PmGoDb;
  /**
   * `planId` for the span row. Required by the FK on `workflow_events`.
   * Callers thread this through from the activity scope; `withSpan`
   * surfaces it via `attrs.planId` when present.
   */
  planId: string;
}

export interface SpanWriter {
  writeSpan(span: Span): Promise<void>;
}

/**
 * Build a DB-backed span writer. The caller owns the `db` handle and
 * the `planId` binding — the writer is deliberately scoped to a single
 * plan per activity invocation so FK-violation paths stay tractable.
 */
export function createSpanWriter(deps: SpanWriterDeps): SpanWriter {
  const { db, planId } = deps;

  return {
    async writeSpan(span: Span): Promise<void> {
      try {
        await db.insert(workflowEvents).values({
          id: newUuid(),
          planId,
          phaseId: null,
          taskId: null,
          kind: "span_emitted",
          payload: span,
          traceId: span.traceId,
          spanId: span.spanId,
          createdAt: span.finishedAt,
        });
      } catch (err) {
        console.warn(
          `[observability] writeSpan failed (trace=${span.traceId} span=${span.spanId} name=${span.name}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}
