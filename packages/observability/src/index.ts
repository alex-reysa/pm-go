/**
 * `@pm-go/observability` — Phase 7 activity-scoped tracing library.
 *
 * Public surface:
 *   - `withSpan(name, attrs, fn)`: wraps a callable in a span that
 *     records duration, outcome, and correlation ids.
 *   - `startTrace(planId)`: reserves a fresh trace/rootSpan id pair.
 *   - `writeSpan(ctx, status, error, sink, name)`: low-level emitter.
 *   - `createSpanWriter({ db, planId })`: DB-backed sink that inserts
 *     `workflow_events` rows with `kind='span_emitted'`.
 *
 * Phase 7 deliberately omits any OTel exporter. `@opentelemetry/api`
 * is declared as a dependency for forward-compatibility with the
 * Phase 8 plan (workflow-level interceptor + external exporter), but
 * Phase 7's ambient-context propagation uses Node's
 * `AsyncLocalStorage` directly because the OTel API ships with a
 * `NoopContextManager` that no-ops without the full SDK installed.
 * The DB row on `workflow_events` is the span sink.
 */
export { withSpan } from "./with-span.js";
export type { SpanSink, WithSpanOptions } from "./with-span.js";
export { startTrace } from "./trace.js";
export { writeSpan } from "./write-span.js";
export { createSpanWriter } from "./db-writer.js";
export type { SpanWriter, SpanWriterDeps } from "./db-writer.js";
export { getActiveSpan, withActiveSpan, resolveInheritedTrace } from "./context.js";
export type { ActiveSpanRef } from "./context.js";
export type { Span, SpanContext, SpanStatus, TraceContext } from "@pm-go/contracts/observability";
