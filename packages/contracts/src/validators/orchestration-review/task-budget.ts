import { Type, type Static } from "@sinclair/typebox";

import type { TaskBudget } from "../../plan.js";

/**
 * TypeBox schema for `TaskBudget`. Enforces non-negative minutes/cost/tokens.
 */
export const TaskBudgetSchema = Type.Object({
  maxWallClockMinutes: Type.Number({ minimum: 0 }),
  maxModelCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
  maxPromptTokens: Type.Optional(Type.Integer({ minimum: 0 }))
});

export type TaskBudgetSchemaType = Static<typeof TaskBudgetSchema>;

type _TaskBudgetSubtypeCheck = TaskBudgetSchemaType extends TaskBudget
  ? true
  : never;
const _budgetOk: _TaskBudgetSubtypeCheck = true;
void _budgetOk;
