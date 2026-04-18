/**
 * JSON Schema export for `Plan`.
 *
 * TypeBox schemas ARE JSON Schema at runtime (same object shape), so
 * we simply re-export the validator-side schema here. Consumers that
 * need a `JSONSchema7`-compatible payload can pass `PlanJsonSchema`
 * directly to the Claude Agent SDK executor adapter's
 * `outputFormat: { type: 'json_schema', schema }` field.
 */

export { PlanSchema as PlanJsonSchema } from "../../validators/orchestration-review/plan.js";
