/**
 * Unit coverage for the pure attach state machine. Tests live close
 * to the transitions rather than to the component because the
 * transitions are the load-bearing contract — the React layer is a
 * thin renderer of these outputs.
 */

import { describe, expect, it, vi } from "vitest";

import type { HealthEnvelope } from "../../src/shared/health.js";
import type {
  AttachContext,
  AttachEvent,
} from "../../src/renderer/attachMachine.js";
import {
  initialContext,
  reduce,
  runProbe,
} from "../../src/renderer/attachMachine.js";
import type { PmGoDesktopBridge, ProbeResult } from "../../src/renderer/bridge.js";

const ENVELOPE: HealthEnvelope = {
  status: "ok",
  service: "pm-go-api",
  version: "0.8.8.0",
  instance: "primary",
  port: 3001,
};

const BASE_URL = "http://localhost:3001";

/** Mock bridge factory. `probeResult` is the value `probeHealth` resolves to. */
function makeBridge(
  probeResult: ProbeResult | (() => Promise<ProbeResult>),
): PmGoDesktopBridge {
  return {
    getConfig: vi.fn(async () => ({ apiBaseUrl: BASE_URL })),
    setApiBaseUrl: vi.fn(async (url: string) => ({ apiBaseUrl: url })),
    probeHealth: vi.fn(async () => {
      return typeof probeResult === "function"
        ? probeResult()
        : probeResult;
    }),
  };
}

describe("initialContext", () => {
  it("stays in not_configured when apiBaseUrl is empty", () => {
    expect(initialContext({ apiBaseUrl: "" })).toEqual({
      state: "not_configured",
      baseUrl: "",
      envelope: null,
    });
  });

  it("transitions to probing when apiBaseUrl is set", () => {
    // Per the task: "On first mount, if config has a apiBaseUrl,
    // transition not_configured → probing automatically".
    expect(initialContext({ apiBaseUrl: BASE_URL })).toEqual({
      state: "probing",
      baseUrl: BASE_URL,
      envelope: null,
    });
  });
});

describe("reduce", () => {
  const baseCtx: AttachContext = {
    state: "probing",
    baseUrl: BASE_URL,
    envelope: null,
  };

  it("probe_start transitions any state to probing and clears envelope", () => {
    const connected: AttachContext = {
      state: "connected",
      baseUrl: BASE_URL,
      envelope: ENVELOPE,
    };
    expect(reduce(connected, { type: "probe_start" })).toEqual({
      state: "probing",
      baseUrl: BASE_URL,
      envelope: null,
    });
  });

  it("probe_connected transitions to connected with envelope", () => {
    expect(
      reduce(baseCtx, { type: "probe_connected", envelope: ENVELOPE }),
    ).toEqual({
      state: "connected",
      baseUrl: BASE_URL,
      envelope: ENVELOPE,
    });
  });

  it("probe_unreachable → api_unreachable, envelope cleared", () => {
    expect(reduce(baseCtx, { type: "probe_unreachable" })).toEqual({
      state: "api_unreachable",
      baseUrl: BASE_URL,
      envelope: null,
    });
  });

  it("probe_foreign → foreign_service, envelope cleared", () => {
    // The canonical guard against the v0.8.5-era "nginx says ok" bug:
    // a 2xx with a non-pm-go body must land in foreign_service, never
    // connected.
    expect(reduce(baseCtx, { type: "probe_foreign" })).toEqual({
      state: "foreign_service",
      baseUrl: BASE_URL,
      envelope: null,
    });
  });

  it("probe_api_error → api_error, envelope cleared", () => {
    expect(reduce(baseCtx, { type: "probe_api_error" })).toEqual({
      state: "api_error",
      baseUrl: BASE_URL,
      envelope: null,
    });
  });

  it("set_base_url with empty string lands in not_configured and clears envelope", () => {
    const connected: AttachContext = {
      state: "connected",
      baseUrl: BASE_URL,
      envelope: ENVELOPE,
    };
    expect(reduce(connected, { type: "set_base_url", baseUrl: "" })).toEqual({
      state: "not_configured",
      baseUrl: "",
      envelope: null,
    });
  });

  it("set_base_url with non-empty value lands in probing and clears envelope", () => {
    const connected: AttachContext = {
      state: "connected",
      baseUrl: BASE_URL,
      envelope: ENVELOPE,
    };
    const newUrl = "http://other-host:3002";
    expect(
      reduce(connected, { type: "set_base_url", baseUrl: newUrl }),
    ).toEqual({
      state: "probing",
      baseUrl: newUrl,
      envelope: null,
    });
  });

  it("retry transitions any failure state to probing", () => {
    for (const failureState of [
      "api_unreachable",
      "foreign_service",
      "api_error",
    ] as const) {
      const ctx: AttachContext = {
        state: failureState,
        baseUrl: BASE_URL,
        envelope: null,
      };
      expect(reduce(ctx, { type: "retry" })).toEqual({
        state: "probing",
        baseUrl: BASE_URL,
        envelope: null,
      });
    }
  });

  it("retry with an empty baseUrl is a no-op (returns same ctx)", () => {
    const ctx: AttachContext = {
      state: "not_configured",
      baseUrl: "",
      envelope: null,
    };
    expect(reduce(ctx, { type: "retry" })).toBe(ctx);
  });
});

/**
 * Full state-transition matrix mandated by acceptance criterion
 * ccccccc3-0002. Each scenario drives `runProbe` against a mock
 * bridge and verifies the exact sequence of dispatched events, then
 * the resulting reducer state.
 */
describe("runProbe drives the state-transition matrix", () => {
  /** Helper: pipe runProbe's dispatches into a reducer and report final state. */
  async function driveProbe(
    start: AttachContext,
    bridge: PmGoDesktopBridge,
  ): Promise<{ events: AttachEvent[]; final: AttachContext }> {
    const events: AttachEvent[] = [];
    let ctx = start;
    const dispatch = (event: AttachEvent): void => {
      events.push(event);
      ctx = reduce(ctx, event);
    };
    await runProbe(bridge, dispatch);
    return { events, final: ctx };
  }

  it("not_configured → probing → connected (with envelope)", async () => {
    // Simulate first-mount auto-probe: config had a URL, so the
    // initial state is `probing`; the bridge returns a valid envelope.
    const start = initialContext({ apiBaseUrl: BASE_URL });
    expect(start.state).toBe("probing");
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const { events, final } = await driveProbe(start, bridge);
    expect(events).toEqual([
      { type: "probe_start" },
      { type: "probe_connected", envelope: ENVELOPE },
    ]);
    expect(final).toEqual({
      state: "connected",
      baseUrl: BASE_URL,
      envelope: ENVELOPE,
    });
  });

  it("probing → api_unreachable (network error)", async () => {
    const start = initialContext({ apiBaseUrl: BASE_URL });
    const bridge = makeBridge({
      kind: "api_unreachable",
      message: "ECONNREFUSED",
    });
    const { events, final } = await driveProbe(start, bridge);
    expect(events).toEqual([
      { type: "probe_start" },
      { type: "probe_unreachable" },
    ]);
    expect(final.state).toBe("api_unreachable");
    expect(final.envelope).toBeNull();
  });

  it("probing → foreign_service (2xx non-envelope)", async () => {
    // This is the critical regression guard: nginx default page or
    // `{ status: "ok" }` legacy body MUST land here, NEVER in
    // `connected`.
    const start = initialContext({ apiBaseUrl: BASE_URL });
    const bridge = makeBridge({ kind: "foreign_service", status: 200 });
    const { events, final } = await driveProbe(start, bridge);
    expect(events).toEqual([
      { type: "probe_start" },
      { type: "probe_foreign" },
    ]);
    expect(final.state).toBe("foreign_service");
    expect(final.envelope).toBeNull();
  });

  it("probing → api_error (5xx)", async () => {
    const start = initialContext({ apiBaseUrl: BASE_URL });
    const bridge = makeBridge({ kind: "api_error", status: 503 });
    const { events, final } = await driveProbe(start, bridge);
    expect(events).toEqual([
      { type: "probe_start" },
      { type: "probe_api_error" },
    ]);
    expect(final.state).toBe("api_error");
    expect(final.envelope).toBeNull();
  });

  it("bridge throw is caught and surfaces as api_error", async () => {
    // Defense-in-depth: the renderer must never lock itself in `probing`
    // if the bridge itself blows up.
    const start = initialContext({ apiBaseUrl: BASE_URL });
    const bridge: PmGoDesktopBridge = {
      getConfig: vi.fn(),
      setApiBaseUrl: vi.fn(),
      probeHealth: vi.fn(async () => {
        throw new Error("bridge not wired");
      }),
    };
    const { events, final } = await driveProbe(start, bridge);
    expect(events).toEqual([
      { type: "probe_start" },
      { type: "probe_api_error" },
    ]);
    expect(final.state).toBe("api_error");
  });

  describe("retry from each failure state", () => {
    for (const [failureState, probeKind, expectedTerminal] of [
      ["api_unreachable", "connected", "connected"],
      ["foreign_service", "connected", "connected"],
      ["api_error", "connected", "connected"],
      ["api_unreachable", "api_unreachable", "api_unreachable"],
      ["foreign_service", "foreign_service", "foreign_service"],
      ["api_error", "api_error", "api_error"],
    ] as const) {
      it(`retry from ${failureState} when probe returns ${probeKind} → ${expectedTerminal}`, async () => {
        // Step 1: start in the failure state.
        let ctx: AttachContext = {
          state: failureState,
          baseUrl: BASE_URL,
          envelope: null,
        };
        // Step 2: user clicks Retry → dispatch a retry event.
        ctx = reduce(ctx, { type: "retry" });
        expect(ctx.state).toBe("probing");
        // Step 3: runProbe issues probe_start (re-enters probing) +
        // the matching terminal event.
        const probeResult: ProbeResult =
          probeKind === "connected"
            ? { kind: "connected", envelope: ENVELOPE }
            : probeKind === "api_unreachable"
              ? { kind: "api_unreachable" }
              : probeKind === "foreign_service"
                ? { kind: "foreign_service" }
                : { kind: "api_error" };
        const bridge = makeBridge(probeResult);
        const events: AttachEvent[] = [];
        const dispatch = (event: AttachEvent): void => {
          events.push(event);
          ctx = reduce(ctx, event);
        };
        await runProbe(bridge, dispatch);
        expect(ctx.state).toBe(expectedTerminal);
        if (expectedTerminal === "connected") {
          expect(ctx.envelope).toEqual(ENVELOPE);
        } else {
          expect(ctx.envelope).toBeNull();
        }
      });
    }
  });
});
