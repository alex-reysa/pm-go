import { Type, type Static } from "@sinclair/typebox";

import type { CompletionChecklistItem } from "../../review.js";
import { UuidSchema } from "../../shared/schema.js";

/**
 * Enumerated `ReviewCheckStatus` values, mirrored from `review.ts`.
 */
export const ReviewCheckStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("not_verified"),
  Type.Literal("waived")
]);

/**
 * Canonical RFC 4122 v4 UUID body, lowercase hex with the standard dash
 * positions. Reused by every typed-evidence-ref pattern below so the
 * accepted UUID shape stays in lockstep with `UuidSchema` (which emits
 * `format: "uuid"`). Defined as a string constant rather than a regex
 * literal because TypeBox `pattern` options expect a JSON-Schema
 * pattern string.
 */
const UUID_PATTERN_BODY =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/**
 * Typed evidence reference schema. Mirrors the `EvidenceRef` type alias
 * in `review.ts`. The union widens the legacy bare-UUID contract to
 * also accept the seven prefixed forms produced by completion and
 * phase auditors:
 *
 * - bare `<uuid>` (legacy artifact ref)
 * - `artifact:<uuid>`
 * - `review:<uuid>`
 * - `phase-audit:<uuid>`
 * - `mergerun:<uuid>`
 * - `policy:<uuid>`
 * - `commit:<40-hex-sha>`
 * - `diff:<40-hex-sha>..<40-hex-sha>`
 *
 * `UuidSchema` is placed first so Ajv short-circuits on the cheapest
 * match for the legacy hot path.
 */
export const EvidenceRefSchema = Type.Union([
  UuidSchema,
  Type.String({ pattern: "^artifact:" + UUID_PATTERN_BODY + "$" }),
  Type.String({ pattern: "^review:" + UUID_PATTERN_BODY + "$" }),
  Type.String({ pattern: "^phase-audit:" + UUID_PATTERN_BODY + "$" }),
  Type.String({ pattern: "^mergerun:" + UUID_PATTERN_BODY + "$" }),
  Type.String({ pattern: "^policy:" + UUID_PATTERN_BODY + "$" }),
  Type.String({ pattern: "^commit:[0-9a-f]{40}$" }),
  Type.String({ pattern: "^diff:[0-9a-f]{40}\\.\\.[0-9a-f]{40}$" })
]);

/**
 * TypeBox schema for `CompletionChecklistItem`.
 */
export const CompletionChecklistItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: ReviewCheckStatusSchema,
  evidenceArtifactIds: Type.Array(EvidenceRefSchema),
  relatedTaskIds: Type.Optional(Type.Array(UuidSchema)),
  notes: Type.Optional(Type.String())
}, { $id: "CompletionChecklistItem", additionalProperties: false });

export type CompletionChecklistItemSchemaType = Static<
  typeof CompletionChecklistItemSchema
>;

type _ChecklistItemSubtypeCheck =
  CompletionChecklistItemSchemaType extends CompletionChecklistItem
    ? true
    : never;
const _checklistOk: _ChecklistItemSubtypeCheck = true;
void _checklistOk;
