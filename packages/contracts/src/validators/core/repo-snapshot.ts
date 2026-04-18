import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { Iso8601Schema, UuidSchema } from "../../shared/schema.js";
import type { RepoSnapshot } from "../../execution.js";
// Register `uuid` and `date-time` formats in the TypeBox
// FormatRegistry. Side-effect import — see ./formats.ts.
import "./formats.js";

/**
 * TypeBox schema for {@link RepoSnapshot}. `repoUrl` is the only
 * optional property; every other field is required.
 */
export const RepoSnapshotSchema = Type.Object(
  {
    id: UuidSchema,
    repoRoot: Type.String(),
    repoUrl: Type.Optional(Type.String()),
    defaultBranch: Type.String(),
    headSha: Type.String(),
    languageHints: Type.Array(Type.String()),
    frameworkHints: Type.Array(Type.String()),
    buildCommands: Type.Array(Type.String()),
    testCommands: Type.Array(Type.String()),
    ciConfigPaths: Type.Array(Type.String()),
    capturedAt: Iso8601Schema
  },
  { $id: "RepoSnapshot", additionalProperties: false }
);

export type RepoSnapshotStatic = Static<typeof RepoSnapshotSchema>;

/**
 * Runtime validator. Returns `true` iff `value` conforms to
 * {@link RepoSnapshotSchema}, narrowing to {@link RepoSnapshot}.
 */
export function validateRepoSnapshot(value: unknown): value is RepoSnapshot {
  return Value.Check(RepoSnapshotSchema, value);
}

// Compile-time assertion: structural compatibility with the authoritative
// `RepoSnapshot` interface. The one-way `extends` check tolerates
// TypeBox's `?: T | undefined` vs. the interface's `?: T` shape while
// still catching missing/extra fields and type mismatches.
type _RepoSnapshotAssignable = RepoSnapshotStatic extends RepoSnapshot
  ? true
  : never;
const _repoSnapshotAssignable: _RepoSnapshotAssignable = true;
void _repoSnapshotAssignable;
