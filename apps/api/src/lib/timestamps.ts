/**
 * Drizzle's `timestamp({ mode: "string" })` returns Postgres' display
 * format (e.g. `"2026-04-15 09:00:00+00"`) rather than RFC 3339 /
 * ISO 8601 (`"2026-04-15T09:00:00.000Z"`). The `Iso8601Schema` validator
 * in `@pm-go/contracts` expects the ISO form. Normalise on read.
 */
export function toIso(dbTimestamp: string): string {
  return new Date(dbTimestamp).toISOString();
}
