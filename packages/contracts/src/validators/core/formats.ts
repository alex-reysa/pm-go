import { FormatRegistry } from "@sinclair/typebox";

/**
 * Register the JSON-Schema string formats referenced by the shared
 * schemas (`UuidSchema` uses `format: "uuid"`, `Iso8601Schema` uses
 * `format: "date-time"`). TypeBox 0.34 ships with an empty
 * `FormatRegistry` and fails `Value.Check` on any schema that
 * references an unknown format — so we must register the formats we
 * rely on before running validators.
 *
 * The regexes here are deliberately pragmatic: they cover the common
 * RFC 4122 / RFC 3339 shapes well enough for contract-boundary
 * validation without pulling in a date-library dependency.
 */

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// RFC 3339 date-time. Tolerates fractional seconds and either `Z` or
// an offset like `+02:00`. Not exhaustive (intentionally), but
// sufficient to reject obviously-malformed timestamps such as
// `"not a date"` or plain date strings missing the time component.
const DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value) => UUID_PATTERN.test(value));
}

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (!DATE_TIME_PATTERN.test(value)) return false;
    const parsed = Date.parse(value);
    return !Number.isNaN(parsed);
  });
}

/** Explicit hook for consumers that want to ensure formats are
 * registered before constructing validators. Importing this module
 * for its side effect is equivalent. */
export function ensureCoreFormatsRegistered(): void {
  // Side effects run at module evaluation time; this function exists
  // so consumers can make the dependency explicit at call sites.
}
