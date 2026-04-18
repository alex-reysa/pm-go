import { Type, type Static } from "@sinclair/typebox";

import type { AcceptanceCriterion } from "../../plan.js";

/**
 * TypeBox schema for `AcceptanceCriterion`.
 */
export const AcceptanceCriterionSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  verificationCommands: Type.Array(Type.String()),
  required: Type.Boolean()
});

export type AcceptanceCriterionSchemaType = Static<typeof AcceptanceCriterionSchema>;

type _AcceptanceCriterionSubtypeCheck =
  AcceptanceCriterionSchemaType extends AcceptanceCriterion ? true : never;
const _acOk: _AcceptanceCriterionSubtypeCheck = true;
void _acOk;
