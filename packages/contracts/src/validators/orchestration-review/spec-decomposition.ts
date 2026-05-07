import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { SpecDecomposition } from "../../decomposition.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { MilestoneManifestSchema } from "./milestone-manifest.js";

/**
 * Enumerated `SpecDecompositionStatus` values, mirrored from
 * `decomposition.ts`. Matches the lifecycle the
 * `SpecDecompositionWorkflow` drives: `pending` → `running` → terminal
 * (`ready` | `failed`).
 */
export const SpecDecompositionStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("running"),
  Type.Literal("ready"),
  Type.Literal("failed")
]);

/**
 * TypeBox schema for `SpecDecomposition`. The runtime invariant that
 * `manifest` is populated iff `status === "ready"` and `errorReason` iff
 * `status === "failed"` is NOT enforced here — both fields are
 * structurally optional and the workflow / API are responsible for
 * upholding the conditional. (TypeBox's discriminated-union support is
 * not load-bearing in this codebase, and a downstream caller that hits
 * a malformed row gets a clear failure mode either way.)
 */
export const SpecDecompositionSchema = Type.Object(
  {
    id: UuidSchema,
    specDocumentId: UuidSchema,
    repoSnapshotId: UuidSchema,
    status: SpecDecompositionStatusSchema,
    manifest: Type.Optional(MilestoneManifestSchema),
    errorReason: Type.Optional(Type.String()),
    planFirstStartedAt: Type.Optional(Iso8601Schema),
    createdAt: Iso8601Schema,
    updatedAt: Iso8601Schema
  },
  { $id: "SpecDecomposition", additionalProperties: false }
);

export type SpecDecompositionSchemaType = Static<typeof SpecDecompositionSchema>;

type _SpecDecompositionSubtypeCheck =
  SpecDecompositionSchemaType extends SpecDecomposition ? true : never;
const _specDecompositionOk: _SpecDecompositionSubtypeCheck = true;
void _specDecompositionOk;

export function validateSpecDecomposition(
  value: unknown
): value is SpecDecomposition {
  return Value.Check(SpecDecompositionSchema, value);
}
