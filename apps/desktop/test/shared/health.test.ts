import { describe, expect, it } from "vitest";

import { isPmGoHealthEnvelope } from "../../src/shared/health.js";

describe("isPmGoHealthEnvelope", () => {
  // The canonical v0.8.8+ envelope. This is the ONLY shape the
  // desktop's attach state machine should treat as `connected`;
  // every assertion below pivots on the guard's binary verdict so
  // a regression that loosens the contract (e.g. dropping the
  // `service` check) fails here loudly.
  const valid = {
    status: "ok",
    service: "pm-go-api",
    version: "0.8.8.0",
    instance: "primary",
    port: 3001,
  };

  it("accepts a real pm-go-api envelope", () => {
    expect(isPmGoHealthEnvelope(valid)).toBe(true);
  });

  it("rejects the legacy { status: 'ok' }-only body (no `service`)", () => {
    // Pre-v0.8.8 API and any pre-identity-aware service. Allowing
    // this through would re-introduce the v0.8.5 bug where a stray
    // nginx returning `{ status: "ok" }` looked `connected`.
    expect(isPmGoHealthEnvelope({ status: "ok" })).toBe(false);
  });

  it("rejects a foreign envelope shaped { ok: true }", () => {
    // Many dev servers / health checks use this shape. It must
    // NOT pass — operators need to see `foreign_service`, not
    // `connected`, so they know the port is wrong.
    expect(isPmGoHealthEnvelope({ ok: true })).toBe(false);
  });

  it("rejects an envelope whose service is not 'pm-go-api'", () => {
    expect(
      isPmGoHealthEnvelope({ ...valid, service: "pm-go-worker" }),
    ).toBe(false);
  });

  it("rejects non-objects (null, arrays, strings, undefined)", () => {
    expect(isPmGoHealthEnvelope(null)).toBe(false);
    expect(isPmGoHealthEnvelope(undefined)).toBe(false);
    expect(isPmGoHealthEnvelope("ok")).toBe(false);
    expect(isPmGoHealthEnvelope([valid])).toBe(false);
  });

  it("rejects envelopes missing version / instance / port", () => {
    const { version: _v, ...noVersion } = valid;
    const { instance: _i, ...noInstance } = valid;
    const { port: _p, ...noPort } = valid;
    expect(isPmGoHealthEnvelope(noVersion)).toBe(false);
    expect(isPmGoHealthEnvelope(noInstance)).toBe(false);
    expect(isPmGoHealthEnvelope(noPort)).toBe(false);
  });

  it("rejects a non-integer / non-finite port", () => {
    expect(isPmGoHealthEnvelope({ ...valid, port: 3001.5 })).toBe(false);
    expect(isPmGoHealthEnvelope({ ...valid, port: Number.NaN })).toBe(false);
    expect(
      isPmGoHealthEnvelope({ ...valid, port: Number.POSITIVE_INFINITY }),
    ).toBe(false);
  });

  it("rejects an envelope whose status is not 'ok'", () => {
    expect(isPmGoHealthEnvelope({ ...valid, status: "degraded" })).toBe(false);
  });
});
