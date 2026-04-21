import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { Span, SpanContext, TraceContext } from "../observability.js";
import { Iso8601Schema, UuidSchema } from "../shared/schema.js";

// Side-effect: register `uuid` + `date-time` format validators with
// TypeBox's global FormatRegistry. Mirrors the events lane, which
// imports the same side-effect module to stay self-sufficient when
// consumed in isolation.
import "./orchestration-review/formats.js";

/**
 * Literal union for `SpanStatus`. Kept colocated with the rest of the
 * observability TypeBox schemas so the lane has no runtime import
 * dependencies on the core orchestration-review lane.
 */
export const SpanStatusSchema = Type.Union(
  [Type.Literal("ok"), Type.Literal("error")],
  { $id: "SpanStatus" },
);

/**
 * TypeBox schema for `TraceContext`. `startTrace` returns this shape;
 * every child span in the trace copies `traceId` forward and sets
 * `parentSpanId` (usually to `rootSpanId` for first-level children).
 */
export const TraceContextSchema = Type.Object(
  {
    traceId: UuidSchema,
    rootSpanId: UuidSchema,
  },
  { $id: "TraceContext", additionalProperties: false },
);

/**
 * TypeBox schema for `SpanContext`. Handed to the `withSpan`
 * callback; the callable may thread the ids onto downstream DB
 * inserts so trace/span correlation survives across activities.
 */
export const SpanContextSchema = Type.Object(
  {
    traceId: UuidSchema,
    spanId: UuidSchema,
    parentSpanId: Type.Optional(UuidSchema),
    startedAt: Iso8601Schema,
    attrs: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "SpanContext", additionalProperties: false },
);

/**
 * TypeBox schema for `Span` — the persisted shape emitted by
 * `writeSpan`. `durationMs` is an integer count of milliseconds.
 * `errorMessage` is only populated when `status === "error"`; the
 * validator does not cross-check the two because the discriminant is
 * not a tagged union.
 */
export const SpanSchema = Type.Object(
  {
    traceId: UuidSchema,
    spanId: UuidSchema,
    parentSpanId: Type.Optional(UuidSchema),
    name: Type.String({ minLength: 1 }),
    startedAt: Iso8601Schema,
    finishedAt: Iso8601Schema,
    durationMs: Type.Integer({ minimum: 0 }),
    status: SpanStatusSchema,
    errorMessage: Type.Optional(Type.String()),
    attrs: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "Span", additionalProperties: false },
);

export type SpanSchemaType = Static<typeof SpanSchema>;
export type SpanContextSchemaType = Static<typeof SpanContextSchema>;
export type TraceContextSchemaType = Static<typeof TraceContextSchema>;

// Compile-time structural sanity: the TypeBox-emitted shapes must be
// assignable to the hand-written contract interfaces. Drifts get
// caught by tsc before runtime tests even run.
type _SpanSubtypeCheck = SpanSchemaType extends Span ? true : never;
const _spanOk: _SpanSubtypeCheck = true;
void _spanOk;

type _SpanContextSubtypeCheck = SpanContextSchemaType extends SpanContext
  ? true
  : never;
const _spanContextOk: _SpanContextSubtypeCheck = true;
void _spanContextOk;

type _TraceContextSubtypeCheck = TraceContextSchemaType extends TraceContext
  ? true
  : never;
const _traceContextOk: _TraceContextSubtypeCheck = true;
void _traceContextOk;

/** Runtime validator for `Span`. Narrows `unknown` to `Span` on success. */
export function validateSpan(value: unknown): value is Span {
  return Value.Check(SpanSchema, value);
}

/** Runtime validator for `SpanContext`. */
export function validateSpanContext(value: unknown): value is SpanContext {
  return Value.Check(SpanContextSchema, value);
}

/** Runtime validator for `TraceContext`. */
export function validateTraceContext(value: unknown): value is TraceContext {
  return Value.Check(TraceContextSchema, value);
}
