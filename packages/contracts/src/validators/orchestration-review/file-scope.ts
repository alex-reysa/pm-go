import { Type, type Static } from "@sinclair/typebox";

import type { FileScope } from "../../plan.js";

/**
 * TypeBox schema for `FileScope`, the whitelist/blacklist of paths a
 * `Task` is allowed to modify.
 */
export const FileScopeSchema = Type.Object({
  includes: Type.Array(Type.String()),
  excludes: Type.Optional(Type.Array(Type.String())),
  packageScopes: Type.Optional(Type.Array(Type.String())),
  maxFiles: Type.Optional(Type.Integer({ minimum: 1 }))
});

export type FileScopeSchemaType = Static<typeof FileScopeSchema>;

type _FileScopeSubtypeCheck = FileScopeSchemaType extends FileScope
  ? true
  : never;
const _fileScopeOk: _FileScopeSubtypeCheck = true;
void _fileScopeOk;
