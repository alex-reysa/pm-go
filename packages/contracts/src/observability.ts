import type { UUID } from "./plan.js";

/**
 * Phase 7 observability contracts. Spans are activity-scoped — there
 * is no workflow-level tracing in Phase 7 (explicitly deferred per the
 * Phase 7 hyper-prompt §1 out-of-scope + §7 invariants). Cross-workflow
 * correlation flows through `workflow_events.trace_id`, which the
 * `@pm-go/observability` package persists alongside every activity
 * that opts into `withSpan`.
 *
 * The `Span` shape is what `writeSpan` emits into `workflow_events`
 * as the JSONB `payload` of a `span_emitted`-kind row (with
 * `trace_id` + `span_id` broken out as indexed columns for replay).
 * The contract is additive to `WorkflowEvent` — Worker 4 widens the
 * event union to include `span_emitted`; Worker 2's writer inserts
 * directly against the `workflow_events` table so the union gap does
 * not block the proof-of-wire.
 */

/**
 * Span lifecycle outcome. Mirrors the OTel `SpanStatusCode` vocabulary
 * without pulling the SDK enum into the contracts surface. "ok" means
 * the wrapped callable returned normally; "error" means it threw and
 * the error was re-raised after the span was written.
 */
export type SpanStatus = "ok" | "error";

/**
 * Root trace metadata returned by `startTrace`. The root span id is
 * reserved by the caller but not persisted until they emit an event
 * (or `withSpan` invocation) that carries it — `startTrace` is
 * deliberately side-effect-free so it stays safe to call inside
 * workflow code that is subject to Temporal determinism checks.
 */
export interface TraceContext {
  /** RFC 4122 UUID identifying the trace. Same value threaded across every child span. */
  traceId: UUID;
  /** RFC 4122 UUID reserved for the top-level span. Children set `parentSpanId` to this value. */
  rootSpanId: UUID;
}

/**
 * Live span context handed to the `withSpan` callback. Carries the
 * correlation ids the callable may attach to downstream inserts
 * (`workflow_events.trace_id` / `span_id`) so span metadata and
 * domain events share a single replay axis.
 *
 * `startedAt` is captured before the callable runs so `writeSpan`
 * can derive `durationMs` deterministically without a second
 * wall-clock read.
 */
export interface SpanContext {
  traceId: UUID;
  spanId: UUID;
  /** Optional parent — omitted for a root-level `withSpan` invocation. */
  parentSpanId?: UUID;
  /** ISO-8601 timestamp captured the instant the span opened. */
  startedAt: string;
  /**
   * Caller-provided attributes recorded on the span row's JSONB
   * payload. Not reserved or well-known; consumers should treat
   * unknown keys permissively.
   */
  attrs: Record<string, unknown>;
}

/**
 * Persisted span shape — what `writeSpan` emits as the payload of
 * a `workflow_events` row (plus `trace_id` / `span_id` lifted out as
 * indexed columns). Independently validatable so fixture round-trips
 * can assert the stored payload without also asserting column layout.
 */
export interface Span {
  traceId: UUID;
  spanId: UUID;
  parentSpanId?: UUID;
  /** Human-readable span name. Convention: `<package>.<fn>` or `<workflow>.<activity>`. */
  name: string;
  /** ISO-8601 timestamp captured when the span opened. */
  startedAt: string;
  /** ISO-8601 timestamp captured when the span closed (success or error). */
  finishedAt: string;
  /** Integer milliseconds, `finishedAt - startedAt`. */
  durationMs: number;
  status: SpanStatus;
  /** Populated only when `status === "error"`. Verbatim error message, no stack. */
  errorMessage?: string;
  attrs: Record<string, unknown>;
}
