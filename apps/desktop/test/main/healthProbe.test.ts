import { describe, expect, it, vi } from "vitest";

import { runHealthProbe } from "../../src/main/healthProbe.js";

/**
 * The full v0.8.8+ envelope. Every "connected" assertion below
 * pivots on this exact shape — the guard
 * (`isPmGoHealthEnvelope`) is unit-tested separately under
 * `test/shared/health.test.ts`; here we just verify the probe
 * routes a guard `true` to `state === "connected"` and a guard
 * `false` (for any reason) to `state === "foreign_service"`.
 */
const validEnvelope = {
  status: "ok" as const,
  service: "pm-go-api" as const,
  version: "0.8.8.0",
  instance: "primary",
  port: 3001,
};

/**
 * Synthesize a minimal `Response`-shaped object that satisfies the
 * fetch-result branches `runHealthProbe` looks at: `.ok`, `.status`,
 * `.json()`. We do NOT use a real `Response` here because Node's
 * polyfill rejects setting `status` in some versions and we need
 * the freedom to construct e.g. a 200 with a non-pm-go body.
 */
function fakeResponse(opts: {
  status: number;
  body?: unknown;
  bodyThrows?: boolean;
}): Response {
  const status = opts.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: opts.bodyThrows
      ? async () => {
          throw new SyntaxError("not JSON");
        }
      : async () => opts.body,
  } as unknown as Response;
}

describe("runHealthProbe", () => {
  it("classifies a fetch rejection as api_unreachable", async () => {
    // Network-layer failure: DNS, ECONNREFUSED, anything that
    // prevents an HTTP response from arriving. The probe must
    // surface the operator-facing "API unreachable" signal, NOT
    // crash the attach loop.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "api_unreachable" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/health",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("classifies a 2xx pm-go envelope as connected (with the full envelope)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: validEnvelope }));
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "connected", envelope: validEnvelope });
  });

  it("classifies a 2xx { ok: true } body as foreign_service", async () => {
    // Many dev servers / load balancers answer `{ ok: true }`.
    // It must surface as `foreign_service`, NOT `connected` — the
    // operator needs to be told the port is wrong, not that they
    // are talking to pm-go.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: { ok: true } }));
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "foreign_service" });
  });

  it("classifies a legacy 2xx { status: 'ok' } (no service) as foreign_service", async () => {
    // Pre-v0.8.8 pm-go API and any pre-identity-aware service that
    // happens to answer `{ status: "ok" }`. Allowing this through
    // would re-introduce the v0.8.5 bug where an nginx welcome page
    // briefly looked `connected`.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ status: 200, body: { status: "ok" } }),
      );
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "foreign_service" });
  });

  it("classifies a non-2xx response as api_error and preserves the status code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 503, body: {} }));
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "api_error", httpStatus: 503 });
  });

  it("classifies a 2xx response with non-JSON body as foreign_service", async () => {
    // An nginx welcome page (HTML) on the same port answers 200 but
    // .json() rejects. That's still operator-facing `foreign_service`:
    // the host is up but not pm-go.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ status: 200, bodyThrows: true }),
      );
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "foreign_service" });
  });

  it("classifies a 2xx envelope with wrong service (pm-go-worker) as foreign_service", async () => {
    // Defense-in-depth: even a sibling pm-go service that listens
    // on the configured port and exposes a v0.8.8-shaped envelope
    // must NOT be reported as `connected` — the desktop is
    // contracted to talk to the API only.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      fakeResponse({
        status: 200,
        body: { ...validEnvelope, service: "pm-go-worker" },
      }),
    );
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ state: "foreign_service" });
  });

  it("normalizes the base URL before issuing the probe", async () => {
    // Operator pasted a trailing-slash URL without a scheme. The
    // probe must hit the canonical `http://host:port/health`, not
    // `host:port//health` or some `new URL`-mangled variant.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ status: 200, body: validEnvelope }));
    await runHealthProbe("  localhost:3001///  ", {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3001/health",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("aborts via timeout and reports api_unreachable", async () => {
    // The fetch never resolves; the probe must abort within
    // `timeoutMs` and classify as `api_unreachable` rather than
    // hanging the attach loop forever.
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
      });
    });
    const result = await runHealthProbe("http://localhost:3001", {
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 10,
    });
    expect(result).toEqual({ state: "api_unreachable" });
  });
});
