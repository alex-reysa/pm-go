import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface SchemaValidationIssue {
  path: string;
  message: string;
  value: unknown;
}

export function collectSchemaValidationIssues(
  schema: TSchema,
  value: unknown,
  limit = 12,
): SchemaValidationIssue[] {
  return [...Value.Errors(schema, value)].slice(0, limit).map((err) => ({
    path: formatJsonPointer(err.path),
    message: err.message,
    value: err.value,
  }));
}

function formatJsonPointer(pointer: string): string {
  if (pointer.length === 0) return "$";
  return `$${pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
    .join("")}`;
}
