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
 * TypeBox schema for `CompletionChecklistItem`.
 */
export const CompletionChecklistItemSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  status: ReviewCheckStatusSchema,
  evidenceArtifactIds: Type.Array(UuidSchema),
  relatedTaskIds: Type.Optional(Type.Array(UuidSchema)),
  notes: Type.Optional(Type.String())
});

export type CompletionChecklistItemSchemaType = Static<
  typeof CompletionChecklistItemSchema
>;

type _ChecklistItemSubtypeCheck =
  CompletionChecklistItemSchemaType extends CompletionChecklistItem
    ? true
    : never;
const _checklistOk: _ChecklistItemSubtypeCheck = true;
void _checklistOk;
