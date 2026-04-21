import { describe, expect, it, vi } from "vitest";

import type { Span } from "@pm-go/contracts";

import { withSpan } from "../src/with-span.js";
import { startTrace } from "../src/trace.js";
import { getActiveSpan } from "../src/context.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function captureSink() {
  const spans: Span[] = [];
  const sink = vi.fn(async (span: Span) => {
    spans.push(span);
  });
  return { sink, spans };
}

describe("withSpan", () => {
  it("happy path emits a span with status='ok' and a measured durationMs", async () => {
    const { sink, spans } = captureSink();
    const value = await withSpan(
      "test.happy",
      { planId: "p1" },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      },
      { sink },
    );

    expect(value).toBe(42);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("test.happy");
    expect(span.status).toBe("ok");
    expect(span.errorMessage).toBeUndefined();
    expect(span.attrs).toEqual({ planId: "p1" });
    expect(span.traceId).toMatch(UUID_RE);
    expect(span.spanId).toMatch(UUID_RE);
    expect(span.parentSpanId).toBeUndefined();
    expect(Number.isInteger(span.durationMs)).toBe(true);
    expect(span.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(span.startedAt)).toBeLessThanOrEqual(
      Date.parse(span.finishedAt),
    );
  });

  it("error path emits status='error' with errorMessage and re-throws the original error", async () => {
    const { sink, spans } = captureSink();
    const boom = new Error("nope");

    await expect(
      withSpan(
        "test.error",
        {},
        async () => {
          throw boom;
        },
        { sink },
      ),
    ).rejects.toBe(boom);

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status).toBe("error");
    expect(span.errorMessage).toBe("nope");
  });

  it("preserves the caller's return type bit-for-bit (reference equality, no serialization)", async () => {
    const { sink } = captureSink();
    const obj = { a: 1, b: { c: "deep" } };

    const result = await withSpan("test.ret", {}, async () => obj, { sink });
    expect(result).toBe(obj);
    expect(result.b).toBe(obj.b);
  });

  it("inherits an explicit traceId from attrs.traceId and records it on the span", async () => {
    const { sink, spans } = captureSink();
    const explicitTrace = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    await withSpan(
      "test.inherit",
      { traceId: explicitTrace, planId: "p1" },
      async () => undefined,
      { sink },
    );

    expect(spans[0]!.traceId).toBe(explicitTrace);
  });

  it("nested withSpan calls inherit the parent's trace and link parentSpanId", async () => {
    const { sink, spans } = captureSink();

    await withSpan(
      "outer",
      {},
      async () => {
        await withSpan(
          "inner",
          {},
          async () => {
            return undefined;
          },
          { sink },
        );
      },
      { sink },
    );

    // sink is called twice; the inner span should finalize before the outer.
    expect(spans).toHaveLength(2);
    const [inner, outer] = spans;
    expect(inner!.name).toBe("inner");
    expect(outer!.name).toBe("outer");
    expect(inner!.traceId).toBe(outer!.traceId);
    expect(inner!.parentSpanId).toBe(outer!.spanId);
    expect(outer!.parentSpanId).toBeUndefined();
  });

  it("exposes the active span to the callback via the ambient-context getter", async () => {
    const { sink } = captureSink();
    let seen: { traceId: string; spanId: string } | undefined;

    await withSpan(
      "test.ambient",
      {},
      async (ctx) => {
        const active = getActiveSpan();
        if (active) seen = active;
        expect(active).toEqual({ traceId: ctx.traceId, spanId: ctx.spanId });
      },
      { sink },
    );

    expect(seen).toBeDefined();
    // Ambient context is cleared once withSpan resolves.
    expect(getActiveSpan()).toBeUndefined();
  });

  it("runs without a sink (in-memory only) and still re-throws errors", async () => {
    await expect(
      withSpan("no-sink", {}, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
  });

  it("survives a sink that itself throws — the wrapper does not unwind the caller", async () => {
    const sink = vi.fn(async () => {
      throw new Error("sink-down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await withSpan("ok", {}, async () => 7, { sink });
    expect(result).toBe(7);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("startTrace", () => {
  it("returns a fresh (traceId, rootSpanId) pair and is side-effect-free", () => {
    const a = startTrace("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const b = startTrace("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    expect(a.traceId).toMatch(UUID_RE);
    expect(a.rootSpanId).toMatch(UUID_RE);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.rootSpanId).not.toBe(b.rootSpanId);
  });
});
