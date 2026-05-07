import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { MilestoneManifest } from "../../decomposition.js";
import { UuidSchema } from "../../shared/schema.js";

import "./formats.js";
import { MilestoneSchema } from "./milestone.js";

/**
 * TypeBox schema for `MilestoneManifest`. Structural-only — it does
 * NOT enforce topological ordering, dependency-target resolvability,
 * or unique milestone ids. Those rules live in {@link auditMilestoneManifest}
 * because TypeBox cannot express cross-element constraints.
 *
 * Doubles as the JSON Schema fed to the decomposer agent's
 * `outputFormat: { type: "json_schema", schema }`. The structured-output
 * contract is `MilestoneManifest@1`.
 */
export const MilestoneManifestSchema = Type.Object(
  {
    specDocumentId: UuidSchema,
    repoSnapshotId: UuidSchema,
    milestones: Type.Array(MilestoneSchema, { minItems: 1 }),
    deferredScope: Type.Array(Type.String({ minLength: 1 }))
  },
  { $id: "MilestoneManifest", additionalProperties: false }
);

export type MilestoneManifestSchemaType = Static<typeof MilestoneManifestSchema>;

type _MilestoneManifestSubtypeCheck =
  MilestoneManifestSchemaType extends MilestoneManifest ? true : never;
const _milestoneManifestOk: _MilestoneManifestSubtypeCheck = true;
void _milestoneManifestOk;

/**
 * Runtime structural validator. A `true` return narrows `value` to a
 * `MilestoneManifest` with shape-correct fields, but does NOT guarantee
 * the manifest is internally consistent (id uniqueness, dependency
 * topology). Always pair with {@link auditMilestoneManifest} when the
 * caller needs end-to-end correctness — for example before persisting
 * the manifest to `spec_decompositions.manifest` or before submitting
 * a milestone plan.
 */
export function validateMilestoneManifest(
  value: unknown
): value is MilestoneManifest {
  return Value.Check(MilestoneManifestSchema, value);
}

/**
 * One issue surfaced by {@link auditMilestoneManifest}. `path` is a
 * dotted accessor relative to the manifest root (e.g.
 * `"milestones[2].dependsOn[0]"`); `code` is a stable machine-readable
 * tag suitable for telemetry / test assertions; `message` is a human
 * sentence safe to render in operator-facing UIs.
 */
export interface MilestoneManifestAuditIssue {
  code:
    | "DUPLICATE_MILESTONE_ID"
    | "DEPENDENCY_REFERENCES_LATER_MILESTONE"
    | "DEPENDENCY_REFERENCES_UNKNOWN_MILESTONE"
    | "DEPENDENCY_SELF_REFERENCE";
  path: string;
  message: string;
}

/**
 * Cross-element audit for a {@link MilestoneManifest}. Returns the list
 * of structural issues found; an empty list means the manifest is
 * internally consistent.
 *
 * Rules enforced:
 * 1. Milestone ids are unique within the manifest.
 * 2. Each `dependsOn` entry references a milestone that appears earlier
 *    in `milestones` (which guarantees topological order and forbids
 *    cycles by construction).
 * 3. A milestone may not depend on itself.
 *
 * The schema-level pattern check on `Milestone.id` is the prerequisite —
 * audit assumes shape validation already passed.
 */
export function auditMilestoneManifest(
  manifest: MilestoneManifest
): MilestoneManifestAuditIssue[] {
  const issues: MilestoneManifestAuditIssue[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < manifest.milestones.length; i += 1) {
    const milestone = manifest.milestones[i];
    if (!milestone) continue;

    const previous = seen.get(milestone.id);
    if (previous !== undefined) {
      issues.push({
        code: "DUPLICATE_MILESTONE_ID",
        path: `milestones[${i}].id`,
        message: `Duplicate milestone id "${milestone.id}" — first seen at milestones[${previous}].`
      });
    } else {
      seen.set(milestone.id, i);
    }

    for (let j = 0; j < milestone.dependsOn.length; j += 1) {
      const dep = milestone.dependsOn[j];
      if (dep === undefined) continue;
      const path = `milestones[${i}].dependsOn[${j}]`;

      if (dep === milestone.id) {
        issues.push({
          code: "DEPENDENCY_SELF_REFERENCE",
          path,
          message: `Milestone "${milestone.id}" cannot depend on itself.`
        });
        continue;
      }

      const depIndex = seen.get(dep);
      if (depIndex === undefined) {
        const laterIndex = manifest.milestones.findIndex(
          (m, idx) => idx > i && m.id === dep
        );
        if (laterIndex >= 0) {
          issues.push({
            code: "DEPENDENCY_REFERENCES_LATER_MILESTONE",
            path,
            message: `Milestone "${milestone.id}" depends on "${dep}", which appears later (milestones[${laterIndex}]). Manifest must be topologically ordered.`
          });
        } else {
          issues.push({
            code: "DEPENDENCY_REFERENCES_UNKNOWN_MILESTONE",
            path,
            message: `Milestone "${milestone.id}" depends on "${dep}", which is not present in the manifest.`
          });
        }
      }
    }
  }

  return issues;
}
