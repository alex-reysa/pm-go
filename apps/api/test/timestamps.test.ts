import { describe, expect, it } from "vitest";

import { toIso } from "../src/lib/timestamps.js";

describe("toIso", () => {
  it("converts Postgres display-format timestamptz to ISO 8601", () => {
    // The exact shape Drizzle's `mode: "string"` hands back for timestamptz.
    expect(toIso("2026-04-15 09:00:00+00")).toBe("2026-04-15T09:00:00.000Z");
  });

  it("normalises timestamps with an offset to UTC", () => {
    expect(toIso("2026-04-15 11:00:00+02")).toBe("2026-04-15T09:00:00.000Z");
  });

  it("passes through values that are already ISO 8601", () => {
    expect(toIso("2026-04-15T09:00:00.000Z")).toBe("2026-04-15T09:00:00.000Z");
  });

  it("preserves millisecond precision", () => {
    expect(toIso("2026-04-15 09:00:00.123+00")).toBe("2026-04-15T09:00:00.123Z");
  });
});
