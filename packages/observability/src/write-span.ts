import type { Span, SpanContext, SpanStatus } from "@pm-go/contracts/observability";

import type { SpanSink } from "./with-span.js";

/**
 * Low-level span writer — exported for callers that want to emit a
 * span without the `withSpan` wrapper (e.g. a span that spans two
 * activities, or a post-hoc span recorded from an operator action).
 * Most consumers should reach for `withSpan` instead; this function
 * exists so the same `Span` record can be constructed independently
 * of the wrapper's lifecycle semantics.
 *
 * `ctx.startedAt` is honored as the span's `startedAt`; the
 * `finishedAt` timestamp is sampled at the moment `writeSpan` is
 * called. Callers who need a tighter bound should compute it
 * themselves and pass the span straight to their sink.
 */
export async function writeSpan(
  ctx: SpanContext,
  status: SpanStatus,
  error: unknown,
  sink: SpanSink,
  name = "anonymous",
): Promise<void> {
  const finishedAt = new Date();
  const startedAt = Date.parse(ctx.startedAt);
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt);

  const base: Omit<Span, "parentSpanId" | "errorMessage"> = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    name,
    startedAt: ctx.startedAt,
    finishedAt: finishedAt.toISOString(),
    durationMs,
    status,
    attrs: ctx.attrs,
  };
  const span: Span = {
    ...base,
    ...(ctx.parentSpanId ? { parentSpanId: ctx.parentSpanId } : {}),
    ...(status === "error"
      ? { errorMessage: error instanceof Error ? error.message : String(error) }
      : {}),
  };

  try {
    await sink(span);
  } catch (sinkErr) {
    console.warn(
      `[observability] writeSpan sink failed (trace=${span.traceId} span=${span.spanId}): ${
        sinkErr instanceof Error ? sinkErr.message : String(sinkErr)
      }`,
    );
  }
}
