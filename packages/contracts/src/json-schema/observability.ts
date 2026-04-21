/**
 * JSON Schema export for the Phase 7 observability contracts.
 * Re-exports the TypeBox schemas under `JsonSchema`-suffixed names so
 * consumers can wire them into output-format gates or emit them to a
 * `$ref`-able document without pulling the validator-side API.
 *
 * Mirrors the `json-schema/events/*` pattern used by Phase 6's
 * workflow-event contracts.
 */

export {
  SpanSchema as SpanJsonSchema,
  SpanContextSchema as SpanContextJsonSchema,
  TraceContextSchema as TraceContextJsonSchema,
  SpanStatusSchema as SpanStatusJsonSchema,
} from "../validators/observability.js";
