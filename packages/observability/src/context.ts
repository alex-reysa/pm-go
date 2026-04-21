import { AsyncLocalStorage } from "node:async_hooks";

import type { SpanContext, TraceContext } from "@pm-go/contracts/observability";

/**
 * Ambient span context — the current trace/span pair visible to any
 * `withSpan` invocation that doesn't receive explicit overrides in
 * `attrs.traceId` / `attrs.parentSpanId`.
 *
 * Phase 7 uses Node's `AsyncLocalStorage` directly rather than
 * `@opentelemetry/api`'s `context` registry. The OTel API ships with
 * a `NoopContextManager` by default and only upgrades to a working
 * propagator when the full SDK (`@opentelemetry/sdk-node`) is
 * registered — and Phase 7's constraints forbid pulling the SDK.
 * `AsyncLocalStorage` gives us the same semantics (async-aware
 * propagation through await, setTimeout, promises) without needing
 * an exporter pipeline.
 *
 * Temporal workflow code is deterministic and must NOT observe
 * ambient context. Phase 7 spans are activity-scoped, so the ambient
 * context lives inside the activity invocation; workflows never read
 * from it.
 */

export interface ActiveSpanRef {
  traceId: SpanContext["traceId"];
  spanId: SpanContext["spanId"];
}

const activeSpanStore = new AsyncLocalStorage<ActiveSpanRef>();

/** Read the currently-active span, if any. */
export function getActiveSpan(): ActiveSpanRef | undefined {
  return activeSpanStore.getStore();
}

/**
 * Run `fn` with the given span marked active. Uses
 * `AsyncLocalStorage.run`, which propagates through every
 * `await`-respecting continuation. The returned value is whatever
 * `fn` returned (preserves generics exactly).
 */
export function withActiveSpan<T>(active: ActiveSpanRef, fn: () => T): T {
  return activeSpanStore.run(active, fn);
}

/**
 * Derive a best-effort trace id for a new span: prefer an explicit
 * caller override on `attrs.traceId`, else inherit from ambient
 * context, else return `undefined` — the caller allocates a fresh id
 * in that case.
 */
export function resolveInheritedTrace(
  attrs: Record<string, unknown>,
): { traceId?: TraceContext["traceId"]; parentSpanId?: SpanContext["spanId"] } {
  const override = typeof attrs["traceId"] === "string" ? (attrs["traceId"] as string) : undefined;
  const overrideParent =
    typeof attrs["parentSpanId"] === "string" ? (attrs["parentSpanId"] as string) : undefined;

  if (override) {
    const result: {
      traceId: TraceContext["traceId"];
      parentSpanId?: SpanContext["spanId"];
    } = { traceId: override };
    if (overrideParent) result.parentSpanId = overrideParent;
    return result;
  }

  const ambient = getActiveSpan();
  if (ambient) {
    return { traceId: ambient.traceId, parentSpanId: ambient.spanId };
  }
  return {};
}
