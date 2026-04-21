# @pm-go/observability

Phase 7 activity-scoped tracing library. Provides a `withSpan` wrapper,
a `startTrace` id reservation helper, and a DB-backed span sink that
writes onto `workflow_events` with `kind='span_emitted'`.

## Scope (Phase 7)

- Activity-level spans only. No Temporal workflow-level interceptor.
- No OTel exporter (no Jaeger, Honeycomb, OTLP, etc.). The `workflow_events`
  row IS the sink; the TUI event stream shows spans alongside the rest of
  the operator timeline.
- Cross-workflow correlation flows through `workflow_events.trace_id` —
  not through OTel's propagation layer.
- Phase 8 may lift the wrapper to the workflow layer and wire an external
  exporter. Phase 7 explicitly defers both.

## Public API

### `withSpan<T>(name, attrs, fn, options?): Promise<T>`

Wraps `fn` in a span. Preserves the caller's return type exactly (the
generic `<T>` is the reason — activities thread typed return values to
workflows, and the wrapper must not observe the value).

```ts
import { withSpan, createSpanWriter } from "@pm-go/observability";

const sink = createSpanWriter({ db, planId }).writeSpan;

const result = await withSpan(
  "worker.activities.events.emitWorkflowEvent",
  { planId, kind: "phase_status_changed" },
  async (ctx) => {
    // ctx.traceId / ctx.spanId are available for downstream inserts
    // to carry into their own `workflow_events` rows, if needed.
    return await doTheWork();
  },
  { sink },
);
```

Inheritance rules:
1. If `attrs.traceId` is a string, use it as the trace id. If
   `attrs.parentSpanId` is a string, use it as the parent.
2. Otherwise, if an ambient span is active (set by an enclosing
   `withSpan`), inherit its `traceId` and use its `spanId` as the parent.
3. Otherwise, a fresh trace id is allocated. The span is a root.

Error semantics: on throw, the span is written with `status: "error"`
and `errorMessage` populated, then the original error is re-raised
(same instance, preserving the stack). On success, the span is written
with `status: "ok"` and the caller's return value is returned verbatim.

### `startTrace(planId: UUID): TraceContext`

Reserves a fresh `{ traceId, rootSpanId }` pair. **Deliberately
side-effect-free** — no DB row is persisted here. The caller is
responsible for emitting an event (typically the first `withSpan`
under the new trace) that threads these ids into `workflow_events`.

This separation keeps `startTrace` safe to call from any scope,
including pre-workflow bootstrap code where no DB handle exists yet.

### `writeSpan(ctx, status, error, sink, name?)`

Low-level emitter for advanced use. Prefer `withSpan` — this exists
for the minority case where a span's open and close need to be
disjoint (e.g. a span recorded from an operator action that completes
in a separate activity invocation from where it started).

### `createSpanWriter({ db, planId }): SpanWriter`

Builds a DB-backed sink. The `planId` is baked in because
`workflow_events.plan_id` has an FK constraint — scoping the writer
to a single plan per invocation keeps FK-violation paths tractable.

Emission is best-effort: DB failures are logged via `console.warn` and
swallowed. The observability layer **must never** roll back a
successful activity. This mirrors the Phase 6 `emitWorkflowEvent`
contract.

## Integration pattern (what Worker 4 applies broadly)

Worker 2's proof-of-wire wraps a single activity
(`emitWorkflowEvent` in `apps/worker/src/activities/events.ts`).
Worker 4 applies the same pattern to every activity that writes
durable state. The pattern:

1. Accept `PmGoDb` via the existing `deps` object. (Activities
   already have this.)
2. Inside the factory-returned activity function, build a plan-scoped
   `SpanWriter` at the top: `const sink = createSpanWriter({ db, planId: input.planId }).writeSpan;`
3. Replace the original body with a `withSpan(name, attrs, async () => { ... }, { sink })`
   wrapping the original body verbatim. `name` follows the convention
   `<package>.<module>.<fn>`; `attrs` should include `planId` and any
   other correlation keys that help operators (e.g. `taskId`, `phaseId`,
   `kind`).
4. Do NOT change the activity's return shape or error-throwing
   semantics. `withSpan` is wrapping-only.

## Fixtures and contracts

Span shape is defined in `@pm-go/contracts/observability`:

- `Span` — the persisted shape (written to `workflow_events.payload`)
- `SpanContext` — handed to the `withSpan` callback
- `TraceContext` — returned by `startTrace`
- `SpanStatus` — `"ok" | "error"`

See `packages/contracts/src/fixtures/span-*.json` for valid shapes
and `packages/contracts/src/validators/observability.ts` for the
TypeBox schemas + `validateSpan` / `validateSpanContext` /
`validateTraceContext` runtime validators.

## Schema + migration

Migration `0012_workflow_events_trace_columns.sql`:
- adds `trace_id` and `span_id` (nullable `text`) columns to
  `workflow_events`
- adds `span_emitted` to the `workflow_event_kind` enum
- indexes `trace_id` for trace-scoped replay queries

Rows written by `createSpanWriter` have `kind='span_emitted'`,
`trace_id`/`span_id` populated, and the full `Span` record as
JSONB `payload`.
