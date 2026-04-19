import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { MergeRun } from "../../execution.js";
import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { GitSha1Schema } from "./completion-audit-report.js";

/**
 * TypeBox schema for `MergeRun`. Persisted as a `merge_runs` row by
 * PhaseIntegrationWorkflow. The optional fields mirror the in-flight /
 * failure shapes: `failedTaskId` set if a task's merge exhausted
 * retries; `integrationHeadSha` + `completedAt` null while the run is
 * in flight.
 */
export const MergeRunSchema = Type.Object(
  {
    id: UuidSchema,
    planId: UuidSchema,
    phaseId: UuidSchema,
    integrationBranch: Type.String(),
    mergedTaskIds: Type.Array(UuidSchema),
    failedTaskId: Type.Optional(UuidSchema),
    integrationHeadSha: Type.Optional(GitSha1Schema),
    startedAt: Iso8601Schema,
    completedAt: Type.Optional(Iso8601Schema),
  },
  { $id: "MergeRun", additionalProperties: false },
);

export type MergeRunSchemaType = Static<typeof MergeRunSchema>;

type _MergeRunSubtypeCheck = MergeRunSchemaType extends MergeRun ? true : never;
const _mergeRunOk: _MergeRunSubtypeCheck = true;
void _mergeRunOk;

/**
 * Runtime validator for `MergeRun`. Narrows `unknown` to `MergeRun` on
 * success.
 */
export function validateMergeRun(value: unknown): value is MergeRun {
  return Value.Check(MergeRunSchema, value);
}
