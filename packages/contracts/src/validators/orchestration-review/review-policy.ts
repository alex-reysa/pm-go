import { Type, type Static } from "@sinclair/typebox";

import type { ReviewPolicy } from "../../plan.js";

/**
 * Enumerated `ReviewStrictness` values, mirrored from `plan.ts`.
 */
export const ReviewStrictnessSchema = Type.Union([
  Type.Literal("standard"),
  Type.Literal("elevated"),
  Type.Literal("critical")
]);

/**
 * TypeBox schema for `ReviewPolicy`. Note that `reviewerWriteAccess` is
 * pinned to the literal `false` — reviewers never write.
 */
export const ReviewPolicySchema = Type.Object({
  required: Type.Boolean(),
  strictness: ReviewStrictnessSchema,
  maxCycles: Type.Integer({ minimum: 0 }),
  reviewerWriteAccess: Type.Literal(false),
  stopOnHighSeverityCount: Type.Integer({ minimum: 0 })
});

export type ReviewPolicySchemaType = Static<typeof ReviewPolicySchema>;

type _ReviewPolicySubtypeCheck = ReviewPolicySchemaType extends ReviewPolicy
  ? true
  : never;
const _policyOk: _ReviewPolicySubtypeCheck = true;
void _policyOk;
