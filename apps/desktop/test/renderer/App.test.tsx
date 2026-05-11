/**
 * Top-level component coverage for the post-attach router gate.
 *
 * We exercise `App` end-to-end through its bridge prop: the test
 * hands `App` a mocked `PmGoDesktopBridge` that drives the auto-
 * probe down a specific path, then asserts whether the phase-0
 * router is allowed to mount. Critically, the `foreign_service`
 * variant must NOT mount the route tree even though the HTTP
 * response was 2xx — that's the load-bearing claim of the gating
 * contract.
 *
 * Like `AttachScreen.test.tsx`, we use `renderToStaticMarkup` to
 * keep the test harness DOM-free. Server rendering does not run
 * effects, so post-probe assertions drive the reducer directly.
 *
 * Note on the rendering approach: the actual first render emits the
 * initial state. To capture the post-probe state, we drive the same
 * reducer manually, then serialize the same AttachScreen + router
 * gate that App uses. This is necessary because
 * `renderToStaticMarkup` doesn't flush async effects on its own.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";
import { describe, expect, it, vi } from "vitest";

import type { Config } from "../../src/shared/config.js";
import type { HealthEnvelope } from "../../src/shared/health.js";
import {
  App,
  AppRoutes,
  POST_ATTACH_LANDING_PATH,
  shouldMountPostAttachRouter,
} from "../../src/renderer/App.js";
import { AttachScreen } from "../../src/renderer/AttachScreen.js";
import type {
  AttachContext,
  AttachEvent,
} from "../../src/renderer/attachMachine.js";
import { initialContext, reduce, runProbe } from "../../src/renderer/attachMachine.js";
import type {
  PmGoDesktopBridge,
  ProbeResult,
} from "../../src/renderer/bridge.js";
import { ROUTES } from "../../src/renderer/router/index.js";

const ENVELOPE: HealthEnvelope = {
  status: "ok",
  service: "pm-go-api",
  version: "0.8.8.0",
  instance: "primary",
  port: 3001,
};
const BASE_URL = "http://localhost:3001";

function makeBridge(probeResult: ProbeResult): PmGoDesktopBridge {
  return {
    getConfig: vi.fn(async () => ({ apiBaseUrl: BASE_URL })),
    setApiBaseUrl: vi.fn(async (url: string) => ({ apiBaseUrl: url })),
    probeHealth: vi.fn(async () => probeResult),
  };
}

/**
 * Drive the auto-probe pipeline and return the post-probe context.
 * Mirrors `App`'s `useEffect` semantics but without React's
 * effect scheduler — we just call `runProbe` directly against the
 * bridge and feed its events into the same reducer. This is the
 * same wiring `App` uses internally; we're reconstructing it here
 * so we can produce a *post-probe* render in the same tick.
 */
async function drivePostProbeContext(
  config: Config,
  bridge: PmGoDesktopBridge,
): Promise<AttachContext> {
  let ctx: AttachContext = initialContext(config);
  const dispatch = (event: AttachEvent): void => {
    ctx = reduce(ctx, event);
  };
  if (config.apiBaseUrl !== "") {
    await runProbe(bridge, dispatch);
  }
  return ctx;
}

function renderPostProbe(ctx: AttachContext, bridge: PmGoDesktopBridge): string {
  // `App` chooses to render `<AppRoutes />` iff
  // `shouldMountPostAttachRouter(ctx)` returns true. We replicate
  // that render shape here because the server renderer cannot flush
  // App's async probe effect, but the predicate and route tree are
  // imported from App itself.
  const dispatch = vi.fn();
  const showRouter = shouldMountPostAttachRouter(ctx);
  return renderToStaticMarkup(
    <div className="app-root" data-testid="app-root">
      <AttachScreen ctx={ctx} dispatch={dispatch} bridge={bridge} />
      {showRouter ? (
        <StaticRouter location={POST_ATTACH_LANDING_PATH}>
          <AppRoutes />
        </StaticRouter>
      ) : null}
    </div>,
  );
}

describe("App — post-attach phase-0 router gating", () => {
  it("renders the phase-0 router at the /runs landing route when state is connected", async () => {
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const ctx = await drivePostProbeContext({ apiBaseUrl: BASE_URL }, bridge);
    expect(ctx.state).toBe("connected");
    expect(shouldMountPostAttachRouter(ctx)).toBe(true);
    expect(POST_ATTACH_LANDING_PATH).toBe(ROUTES.runs.path);
    const html = renderPostProbe(ctx, bridge);
    expect(html).toMatch(/data-testid="app-shell"/);
    expect(html).toMatch(/data-current-route="runs"/);
    expect(html).toMatch(/data-testid="runs-placeholder"/);
    expect(html).toContain("Runs");
    expect(html).not.toMatch(/Dashboard/i);
  });

  it("does NOT render the route tree for foreign_service even though HTTP was 2xx", async () => {
    // Status 200 => `foreign_service`. The route tree must NOT
    // appear; the operator should see the foreign-service remediation
    // instead. This is the most important regression guard in the
    // gating contract.
    const bridge = makeBridge({ kind: "foreign_service", status: 200 });
    const ctx = await drivePostProbeContext({ apiBaseUrl: BASE_URL }, bridge);
    expect(ctx.state).toBe("foreign_service");
    expect(shouldMountPostAttachRouter(ctx)).toBe(false);
    const html = renderPostProbe(ctx, bridge);
    expect(html).not.toMatch(/data-testid="runs-placeholder"/);
    expect(html).not.toMatch(/data-testid="app-shell"/);
  });

  it("does NOT render the route tree for api_unreachable", async () => {
    const bridge = makeBridge({ kind: "api_unreachable" });
    const ctx = await drivePostProbeContext({ apiBaseUrl: BASE_URL }, bridge);
    expect(ctx.state).toBe("api_unreachable");
    expect(shouldMountPostAttachRouter(ctx)).toBe(false);
    const html = renderPostProbe(ctx, bridge);
    expect(html).not.toMatch(/data-testid="runs-placeholder"/);
    expect(html).not.toMatch(/data-testid="app-shell"/);
  });

  it("does NOT render the route tree for api_error", async () => {
    const bridge = makeBridge({ kind: "api_error", status: 500 });
    const ctx = await drivePostProbeContext({ apiBaseUrl: BASE_URL }, bridge);
    expect(ctx.state).toBe("api_error");
    expect(shouldMountPostAttachRouter(ctx)).toBe(false);
    const html = renderPostProbe(ctx, bridge);
    expect(html).not.toMatch(/data-testid="runs-placeholder"/);
    expect(html).not.toMatch(/data-testid="app-shell"/);
  });

  it("does NOT render the route tree for not_configured (empty apiBaseUrl)", async () => {
    // First-launch path: no config, no probe issued, route tree
    // stays hidden. Bridge is irrelevant — the auto-probe is skipped.
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const ctx = await drivePostProbeContext({ apiBaseUrl: "" }, bridge);
    expect(ctx.state).toBe("not_configured");
    expect(shouldMountPostAttachRouter(ctx)).toBe(false);
    const html = renderPostProbe(ctx, bridge);
    expect(html).not.toMatch(/data-testid="runs-placeholder"/);
    expect(html).not.toMatch(/data-testid="app-shell"/);
    // The probe was never dispatched against the bridge.
    expect(bridge.probeHealth).not.toHaveBeenCalled();
  });

  it("does NOT render the route tree while still probing", async () => {
    // Snapshot the App's initial render — `useReducer`'s init makes
    // the state `probing`, and the auto-probe hasn't resolved yet.
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const postAttachRouter = vi.fn((routes: React.ReactNode) => (
      <StaticRouter location={POST_ATTACH_LANDING_PATH}>{routes}</StaticRouter>
    ));
    const html = renderToStaticMarkup(
      <App
        bridge={bridge}
        initialConfig={{ apiBaseUrl: BASE_URL }}
        postAttachRouter={postAttachRouter}
      />,
    );
    expect(html).toMatch(/data-attach-state="probing"/);
    expect(html).not.toMatch(/data-testid="runs-placeholder"/);
    expect(html).not.toMatch(/data-testid="app-shell"/);
    expect(postAttachRouter).not.toHaveBeenCalled();
  });
});

describe("App — auto-probe on mount (acceptance criterion 0002 entry point)", () => {
  it("initial render lands on probing when config has apiBaseUrl", () => {
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const html = renderToStaticMarkup(
      <App bridge={bridge} initialConfig={{ apiBaseUrl: BASE_URL }} />,
    );
    expect(html).toMatch(/data-attach-state="probing"/);
  });

  it("initial render stays in not_configured when config has empty apiBaseUrl", () => {
    const bridge = makeBridge({ kind: "connected", envelope: ENVELOPE });
    const html = renderToStaticMarkup(
      <App bridge={bridge} initialConfig={{ apiBaseUrl: "" }} />,
    );
    expect(html).toMatch(/data-attach-state="not_configured"/);
  });
});
