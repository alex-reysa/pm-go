import { FormatRegistry } from "@sinclair/typebox";

/**
 * Side-effect module that registers the string formats used by
 * orchestration-review lane schemas with TypeBox's global
 * `FormatRegistry`. Without these registrations, `Value.Check` treats
 * any `format: "<name>"` string as an `Unknown format` failure.
 *
 * Registrations are idempotent at the `FormatRegistry` layer: calling
 * `FormatRegistry.Set` again with the same name simply replaces the
 * validator with the same implementation, so importing this module
 * multiple times is safe.
 *
 * The foundation lane intentionally omitted format registration so
 * downstream lanes can co-locate format validators with the schemas
 * that rely on them. This module is the orchestration-review lane's
 * contribution; the other parallel lane (core contracts) may register
 * the same names with equivalent validators without conflict.
 */

// RFC 4122 UUID (any version). Accepts the canonical 8-4-4-4-12 hex
// grouping with lowercase or uppercase digits. Rejects empty strings
// and malformed groupings.
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (value) => UUID_REGEX.test(value));
}

// RFC 3339 / ISO 8601 date-time. Delegates the heavy lifting to
// `Date.parse` and then re-stringifies to catch pathological inputs
// that `Date.parse` accepts but aren't round-trip-stable (e.g. plain
// date strings). A minimum pattern check rejects clearly malformed
// inputs cheaply.
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (value) => {
    if (!ISO_DATE_TIME_REGEX.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
  });
}
