/**
 * Phase 7 observability sub-barrel. Worker 2 (observability core)
 * writes this file; Worker 4 (integration) reconciles the root
 * `packages/contracts/src/index.ts` to re-export from it alongside
 * `policy-exports.ts`. Keeping the sub-barrel separate lets the two
 * Wave-1 workers edit contracts in parallel without touching the
 * same root-level file.
 */

export type {
  Span,
  SpanContext,
  SpanStatus,
  TraceContext,
} from "./observability.js";

export {
  SpanSchema,
  SpanContextSchema,
  TraceContextSchema,
  SpanStatusSchema,
  validateSpan,
  validateSpanContext,
  validateTraceContext,
} from "./validators/observability.js";

export {
  SpanJsonSchema,
  SpanContextJsonSchema,
  TraceContextJsonSchema,
  SpanStatusJsonSchema,
} from "./json-schema/observability.js";
