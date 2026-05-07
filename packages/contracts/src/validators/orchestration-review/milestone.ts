import { Type, type Static } from "@sinclair/typebox";

import type { Milestone } from "../../decomposition.js";

/**
 * Pattern enforced on `Milestone.id`. Two-digit zero-padded ordinal
 * followed by a kebab-case slug — e.g. `m01-acceptance-probe-loop`.
 *
 * Anchored on both ends; the schema validator rejects any extra
 * leading/trailing whitespace or characters.
 */
export const MILESTONE_ID_PATTERN = "^m\\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$";

/**
 * TypeBox schema for the `m\d{2}-slug` milestone id format. Reused by
 * both `Milestone.id` and `Milestone.dependsOn` entries.
 */
export const MilestoneIdSchema = Type.String({
  pattern: MILESTONE_ID_PATTERN
});

/**
 * TypeBox schema for `Milestone`. Doubles as JSON Schema for the
 * decomposer's structured output — so any change here also tightens
 * what the decomposer agent is allowed to emit.
 */
export const MilestoneSchema = Type.Object(
  {
    id: MilestoneIdSchema,
    title: Type.String({ minLength: 1 }),
    summary: Type.String({ minLength: 1 }),
    sourceSections: Type.Array(Type.String({ minLength: 1 })),
    exitCriteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    expectedPhaseCount: Type.Integer({ minimum: 1 }),
    dependsOn: Type.Array(MilestoneIdSchema)
  },
  { $id: "Milestone", additionalProperties: false }
);

export type MilestoneSchemaType = Static<typeof MilestoneSchema>;

type _MilestoneSubtypeCheck = MilestoneSchemaType extends Milestone
  ? true
  : never;
const _milestoneOk: _MilestoneSubtypeCheck = true;
void _milestoneOk;
