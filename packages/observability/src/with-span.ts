import type { Span, SpanContext, SpanStatus } from "@pm-go/contracts/observability";

import { resolveInheritedTrace, withActiveSpan } from "./context.js";
import { newUuid } from "./ids.js";

/**
 * Optional sink invoked once the span is closed. `withSpan` supplies
 * the full `Span` record (including `durationMs`, final status, and
 * optional `errorMessage`). A DB-backed sink is the Phase 7 default
 * (see `createSpanWriter`), but tests and one-off scripts can wire
 * any `(span) => Promise<void>` in its place.
 */
export type SpanSink = (span: Span) => Promise<void>;

/**
 * Options controlling the span lifecycle. `sink` is optional so
 * call-sites in unit tests can skip persistence entirely; in the
 * wired-up worker, the activity layer constructs a writer once per
 * activity-registration and passes it in.
 */
export interface WithSpanOptions {
  /** Persistence sink. If omitted, span is tracked in-memory only. */
  sink?: SpanSink;
}

/**
 * Extract the initial `SpanContext` for a new span. Caller attrs may
 * explicitly override the trace via `attrs.traceId`; otherwise we
 * inherit from OTel's ambient context. The root span of a trace has
 * no `parentSpanId`.
 */
function openSpan(
  name: string,
  attrs: Record<string, unknown>,
): SpanContext {
  void name;
  const { traceId, parentSpanId } = resolveInheritedTrace(attrs);
  const ctx: SpanContext = {
    traceId: traceId ?? newUuid(),
    spanId: newUuid(),
    startedAt: new Date().toISOString(),
    attrs,
  };
  if (parentSpanId) ctx.parentSpanId = parentSpanId;
  return ctx;
}

/**
 * `withSpan` — the core Phase 7 activity wrapper. Opens a span,
 * runs `fn(ctx)`, records the outcome via the optional sink, and
 * re-raises any error thrown by the callable.
 *
 * Return-type preservation is load-bearing: activities wrap
 * transactional DB writes whose return values are consumed by
 * Temporal workflows. `withSpan` must not mutate, stringify, or
 * serialize the return value. The generic `<T>` on the signature
 * keeps the caller's narrowed type intact through the wrapper.
 *
 * Error semantics: the span is written with `status: "error"` and
 * `errorMessage` populated, then the original error is re-thrown.
 * Catch-and-rethrow preserves the original stack (no `throw new` —
 * we re-raise the same instance). This matches the Phase 5 activity
 * contract where activities throw, the workflow catches, and the
 * supervisor decides whether to retry.
 *
 * Synchronicity: `fn` returns a `Promise<T>`. Awaiting inside the
 * wrapper means a thrown error and a rejected promise are handled
 * the same way — either path writes the span and re-raises.
 *
 * Ambient context: while `fn` is running, `withActiveSpan` makes
 * `{ traceId, spanId }` the currently-active span. Nested
 * `withSpan` invocations inherit automatically.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: (ctx: SpanContext) => Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  const ctx = openSpan(name, attrs);

  try {
    const value = await withActiveSpan(
      { traceId: ctx.traceId, spanId: ctx.spanId },
      () => fn(ctx),
    );
    await finalizeSpan(name, ctx, "ok", undefined, options.sink);
    return value;
  } catch (err) {
    await finalizeSpan(name, ctx, "error", err, options.sink);
    // Preserve the original throw. `withSpan` is a wrapper, not a handler.
    throw err;
  }
}

/**
 * Build the persisted `Span` record and hand it to the sink, if any.
 * Sink failures are swallowed here as well — double-emit guards live
 * in the sink itself (`createSpanWriter` logs + continues).
 */
async function finalizeSpan(
  name: string,
  ctx: SpanContext,
  status: SpanStatus,
  error: unknown,
  sink?: SpanSink,
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

  if (!sink) return;
  try {
    await sink(span);
  } catch (sinkErr) {
    console.warn(
      `[observability] span sink failed (trace=${span.traceId} span=${span.spanId} name=${name}): ${
        sinkErr instanceof Error ? sinkErr.message : String(sinkErr)
      }`,
    );
  }
}
