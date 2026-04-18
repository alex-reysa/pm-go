import { Type, type TSchema } from "@sinclair/typebox";

/**
 * Shared TypeBox primitives reused by every contract schema in
 * `packages/contracts`. These helpers keep validation behavior and
 * emitted JSON Schema consistent across Plan, Task, ReviewReport,
 * CompletionAuditReport, AgentRun, and friends.
 *
 * Validators and full schemas for those contracts are intentionally
 * NOT defined here — they belong to the parallel Phase 1a lanes that
 * run after the foundation merges.
 */

/**
 * RFC 4122 UUID string schema. Emits `{"type": "string", "format": "uuid"}`
 * as JSON Schema, which the Claude Agent SDK executor adapter can consume
 * directly via `outputFormat: { type: 'json_schema', schema }`.
 */
export const UuidSchema = Type.String({ format: "uuid" });

/**
 * ISO 8601 / RFC 3339 date-time string schema. Emits
 * `{"type": "string", "format": "date-time"}` as JSON Schema.
 */
export const Iso8601Schema = Type.String({ format: "date-time" });

/**
 * Convention for the `outputFormatSchemaRef` string recorded on an
 * `AgentRun`. The expected shape is `"<ContractName>@<MajorVersion>"`,
 * for example `"Plan@1"` or `"ReviewReport@2"`. This type is a
 * compile-time alias; the exported schema is a runtime-validatable
 * string schema that downstream lanes can refine with a pattern.
 */
export type ContractSchemaRef = `${string}@${number}`;

/**
 * Runtime TypeBox schema for a `ContractSchemaRef`. Kept as a plain
 * string schema at the foundation layer; downstream lanes may add a
 * `pattern` constraint (e.g. `^[A-Za-z][A-Za-z0-9]*@\\d+$`) once the
 * contract naming convention is frozen.
 */
export const ContractSchemaRefSchema: TSchema = Type.String();
