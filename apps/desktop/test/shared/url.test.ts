import { describe, expect, it } from "vitest";

import { normalizeBaseUrl } from "../../src/shared/url.js";

describe("normalizeBaseUrl", () => {
  it("strips a single trailing slash", () => {
    expect(normalizeBaseUrl("http://localhost:3001/")).toBe(
      "http://localhost:3001",
    );
  });

  it("strips multiple trailing slashes", () => {
    expect(normalizeBaseUrl("http://localhost:3001///")).toBe(
      "http://localhost:3001",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBaseUrl("  http://localhost:3001  ")).toBe(
      "http://localhost:3001",
    );
  });

  it("trims whitespace AND strips trailing slashes in one pass", () => {
    expect(normalizeBaseUrl("\thttp://localhost:3001///\n")).toBe(
      "http://localhost:3001",
    );
  });

  it("defaults a missing protocol to http://", () => {
    // Operators almost always paste the bare host:port in a
    // local-first tool. We pick http:// over https:// because the
    // local API never has a cert.
    expect(normalizeBaseUrl("localhost:3001")).toBe("http://localhost:3001");
  });

  it("preserves an explicit https scheme", () => {
    expect(normalizeBaseUrl("https://pm.example.com/")).toBe(
      "https://pm.example.com",
    );
  });

  it("preserves a path segment but strips its trailing slash", () => {
    expect(normalizeBaseUrl("http://host:3001/api/")).toBe(
      "http://host:3001/api",
    );
  });

  it("returns the empty string for empty / whitespace-only input", () => {
    // Sentinel for "operator has not set a value yet" — surfaces
    // as `not_configured` in the attach state machine.
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("   ")).toBe("");
    expect(normalizeBaseUrl("\t\n")).toBe("");
  });

  it("is idempotent on an already-normalized URL", () => {
    const canonical = "http://localhost:3001";
    expect(normalizeBaseUrl(canonical)).toBe(canonical);
    expect(normalizeBaseUrl(normalizeBaseUrl(canonical))).toBe(canonical);
  });
});
