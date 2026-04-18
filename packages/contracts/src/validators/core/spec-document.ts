import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";
import type { SpecDocument } from "../../execution.js";
// Register `uuid` and `date-time` formats in the TypeBox
// FormatRegistry. Side-effect import — see ./formats.ts.
import "./formats.js";

/**
 * TypeBox schema for {@link SpecDocument}. The exported schema object
 * IS valid JSON Schema and can be fed directly to tools that accept
 * JSON Schema (e.g. `outputFormat: { type: 'json_schema', schema }`).
 */
export const SpecDocumentSchema = Type.Object(
  {
    id: UuidSchema,
    title: Type.String(),
    source: Type.Union([Type.Literal("manual"), Type.Literal("imported")]),
    body: Type.String(),
    createdAt: Iso8601Schema
  },
  { $id: "SpecDocument", additionalProperties: false }
);

export type SpecDocumentStatic = Static<typeof SpecDocumentSchema>;

/**
 * Runtime validator. Returns `true` iff `value` conforms to
 * {@link SpecDocumentSchema}, narrowing to {@link SpecDocument}.
 */
export function validateSpecDocument(value: unknown): value is SpecDocument {
  return Value.Check(SpecDocumentSchema, value);
}

// Compile-time assertion: the TypeBox-inferred static type is assignable
// to the authoritative `SpecDocument` interface. Catches structural drift.
type _SpecDocumentAssignable = SpecDocumentStatic extends SpecDocument
  ? true
  : never;
const _specDocumentAssignable: _SpecDocumentAssignable = true;
void _specDocumentAssignable;
