import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { Task } from "../../plan.js";
import { UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { AcceptanceCriterionSchema } from "./acceptance-criterion.js";
import { FileScopeSchema } from "./file-scope.js";
import { ReviewPolicySchema } from "./review-policy.js";
import { RiskLevelSchema } from "./risk.js";
import { TaskBudgetSchema } from "./task-budget.js";

/**
 * Enumerated `TaskKind` values, mirrored from `plan.ts`.
 */
export const TaskKindSchema = Type.Union([
  Type.Literal("foundation"),
  Type.Literal("implementation"),
  Type.Literal("review"),
  Type.Literal("integration"),
  Type.Literal("release")
]);

/**
 * Enumerated `TaskStatus` values, mirrored from `plan.ts`.
 */
export const TaskStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("running"),
  Type.Literal("in_review"),
  Type.Literal("fixing"),
  Type.Literal("ready_to_merge"),
  Type.Literal("merged"),
  Type.Literal("blocked"),
  Type.Literal("failed")
]);

/**
 * TypeBox schema for `Task` from `packages/contracts/src/plan.ts`.
 */
export const TaskSchema = Type.Object({
  id: UuidSchema,
  planId: UuidSchema,
  phaseId: UuidSchema,
  slug: Type.String(),
  title: Type.String(),
  summary: Type.String(),
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  riskLevel: RiskLevelSchema,
  fileScope: FileScopeSchema,
  acceptanceCriteria: Type.Array(AcceptanceCriterionSchema),
  testCommands: Type.Array(Type.String()),
  budget: TaskBudgetSchema,
  reviewerPolicy: ReviewPolicySchema,
  requiresHumanApproval: Type.Boolean(),
  maxReviewFixCycles: Type.Integer({ minimum: 0 }),
  branchName: Type.Optional(Type.String()),
  worktreePath: Type.Optional(Type.String())
});

export type TaskSchemaType = Static<typeof TaskSchema>;

type _TaskSubtypeCheck = TaskSchemaType extends Task ? true : never;
const _taskOk: _TaskSubtypeCheck = true;
void _taskOk;

/**
 * Runtime validator for `Task`. Narrows `unknown` to `Task` on success.
 */
export function validateTask(value: unknown): value is Task {
  return Value.Check(TaskSchema, value);
}
