import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  validateSpan,
  validateSpanContext,
  validateTraceContext,
} from "../src/validators/observability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "../src/fixtures");

const spanOk = JSON.parse(
  readFileSync(resolve(fixtureRoot, "span-ok.json"), "utf8"),
) as unknown;
const spanError = JSON.parse(
  readFileSync(resolve(fixtureRoot, "span-error.json"), "utf8"),
) as unknown;
const spanRoot = JSON.parse(
  readFileSync(resolve(fixtureRoot, "span-root.json"), "utf8"),
) as unknown;

describe("validateSpan", () => {
  it("accepts the span-ok fixture", () => {
    expect(validateSpan(spanOk)).toBe(true);
  });

  it("accepts the span-error fixture (errorMessage populated)", () => {
    expect(validateSpan(spanError)).toBe(true);
  });

  it("accepts the span-root fixture (no parentSpanId)", () => {
    expect(validateSpan(spanRoot)).toBe(true);
  });

  it("rejects a span with a negative durationMs", () => {
    const mutated = { ...(spanOk as Record<string, unknown>), durationMs: -1 };
    expect(validateSpan(mutated)).toBe(false);
  });

  it("rejects a span with an unknown status literal", () => {
    const mutated = { ...(spanOk as Record<string, unknown>), status: "cancelled" };
    expect(validateSpan(mutated)).toBe(false);
  });

  it("rejects a span missing the required name field", () => {
    const { name: _name, ...rest } = spanOk as Record<string, unknown>;
    void _name;
    expect(validateSpan(rest)).toBe(false);
  });

  it("rejects a span whose traceId isn't a UUID", () => {
    const mutated = {
      ...(spanOk as Record<string, unknown>),
      traceId: "not-a-uuid",
    };
    expect(validateSpan(mutated)).toBe(false);
  });

  it("rejects a span with extraneous top-level fields (additionalProperties: false)", () => {
    const mutated = { ...(spanOk as Record<string, unknown>), extra: "nope" };
    expect(validateSpan(mutated)).toBe(false);
  });

  it("rejects a span whose finishedAt isn't an ISO-8601 date-time", () => {
    const mutated = {
      ...(spanOk as Record<string, unknown>),
      finishedAt: "tomorrow",
    };
    expect(validateSpan(mutated)).toBe(false);
  });

  it("rejects a span with a non-integer durationMs", () => {
    const mutated = {
      ...(spanOk as Record<string, unknown>),
      durationMs: 1.5,
    };
    expect(validateSpan(mutated)).toBe(false);
  });
});

describe("validateSpanContext", () => {
  it("accepts a SpanContext derived from span-ok", () => {
    const fx = spanOk as Record<string, unknown>;
    const ctx = {
      traceId: fx["traceId"],
      spanId: fx["spanId"],
      parentSpanId: fx["parentSpanId"],
      startedAt: fx["startedAt"],
      attrs: fx["attrs"],
    };
    expect(validateSpanContext(ctx)).toBe(true);
  });

  it("rejects a SpanContext missing startedAt", () => {
    const fx = spanOk as Record<string, unknown>;
    expect(
      validateSpanContext({
        traceId: fx["traceId"],
        spanId: fx["spanId"],
        attrs: fx["attrs"],
      }),
    ).toBe(false);
  });
});

describe("validateTraceContext", () => {
  it("accepts a well-formed TraceContext", () => {
    expect(
      validateTraceContext({
        traceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        rootSpanId: "11111111-2222-4333-8444-555555555555",
      }),
    ).toBe(true);
  });

  it("rejects a TraceContext with a missing rootSpanId", () => {
    expect(
      validateTraceContext({
        traceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    ).toBe(false);
  });
});
