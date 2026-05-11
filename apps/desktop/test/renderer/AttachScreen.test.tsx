/**
 * Component coverage for {@link AttachScreen}. We deliberately use
 * `react-dom/server.renderToStaticMarkup` instead of jsdom + React
 * Testing Library: the M0 workspace has neither installed, and the
 * acceptance criteria here are about the *output* of a render
 * (which state label appears, which buttons exist, which fields
 * appear), not about real DOM-level interaction. Pure markup
 * inspection is sufficient and avoids dragging a DOM environment
 * into a fileScope-limited task.
 *
 * Behavior-driven interaction tests (Apply re-probes, Retry re-
 * probes, set_base_url clears envelope) live in
 * `attachMachine.test.ts` against the pure reducer — the
 * component's role is just to wire those events up.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ATTACH_STATE_LABELS } from "../../src/shared/attachState.js";
import type { AttachState } from "../../src/shared/attachState.js";
import type { HealthEnvelope } from "../../src/shared/health.js";
import type { AttachContext } from "../../src/renderer/attachMachine.js";
import { AttachScreen } from "../../src/renderer/AttachScreen.js";
import type { PmGoDesktopBridge } from "../../src/renderer/bridge.js";

const ENVELOPE: HealthEnvelope = {
  status: "ok",
  service: "pm-go-api",
  version: "0.8.8.0",
  instance: "primary",
  port: 3001,
};
const BASE_URL = "http://localhost:3001";

function makeBridge(): PmGoDesktopBridge {
  return {
    getConfig: vi.fn(),
    setApiBaseUrl: vi.fn(),
    probeHealth: vi.fn(),
  };
}

/** Build a context in the requested state with sensible defaults. */
function ctxFor(state: AttachState): AttachContext {
  if (state === "connected") {
    return { state, baseUrl: BASE_URL, envelope: ENVELOPE };
  }
  if (state === "not_configured") {
    return { state, baseUrl: "", envelope: null };
  }
  return { state, baseUrl: BASE_URL, envelope: null };
}

function render(ctx: AttachContext): string {
  const dispatch = vi.fn();
  return renderToStaticMarkup(
    <AttachScreen ctx={ctx} dispatch={dispatch} bridge={makeBridge()} />,
  );
}

describe("AttachScreen — per-state rendering (acceptance criterion 0001)", () => {
  const STATES: readonly AttachState[] = [
    "not_configured",
    "probing",
    "connected",
    "api_unreachable",
    "foreign_service",
    "api_error",
  ];

  it("each state produces a distinct user-visible label", () => {
    const labels = new Set<string>();
    for (const state of STATES) {
      const html = render(ctxFor(state));
      const label = ATTACH_STATE_LABELS[state];
      expect(html).toContain(label);
      labels.add(label);
    }
    // Six distinct labels — drop the de-duping `Set` and any
    // accidental collision (e.g. someone reusing "Connected" for two
    // states) will show up as a smaller set size.
    expect(labels.size).toBe(STATES.length);
  });

  it("every state surfaces the base-URL settings input (settings affordance)", () => {
    for (const state of STATES) {
      const html = render(ctxFor(state));
      expect(html).toMatch(/data-testid="base-url-input"/);
      expect(html).toMatch(/data-testid="apply-button"/);
    }
  });

  it("retry button appears for connected + the three failure states", () => {
    for (const state of [
      "connected",
      "api_unreachable",
      "foreign_service",
      "api_error",
    ] as const) {
      const html = render(ctxFor(state));
      expect(html).toMatch(/data-testid="retry-button"/);
    }
  });

  it("retry button does NOT appear for not_configured / probing", () => {
    for (const state of ["not_configured", "probing"] as const) {
      const html = render(ctxFor(state));
      expect(html).not.toMatch(/data-testid="retry-button"/);
    }
  });

  it("connected state renders the full identity envelope", () => {
    const html = render(ctxFor("connected"));
    // Acceptance criterion: display service / version / instance / port.
    expect(html).toContain("pm-go-api");
    expect(html).toContain("0.8.8.0");
    expect(html).toContain("primary");
    expect(html).toContain("3001");
    expect(html).toMatch(/data-testid="identity-envelope"/);
  });

  it("non-connected states do NOT render the identity envelope", () => {
    for (const state of [
      "not_configured",
      "probing",
      "api_unreachable",
      "foreign_service",
      "api_error",
    ] as const) {
      const html = render(ctxFor(state));
      expect(html).not.toMatch(/data-testid="identity-envelope"/);
    }
  });

  it("foreign_service explicitly does not surface a 'pm-go-api' identity", () => {
    // The 2xx-but-foreign body case: even though the server answered
    // with status 200, the UI must NOT pretend it found pm-go-api.
    const html = render(ctxFor("foreign_service"));
    expect(html).not.toContain("pm-go-api");
    expect(html).toContain(ATTACH_STATE_LABELS.foreign_service);
  });

  it("apply button is disabled while probing", () => {
    const html = render(ctxFor("probing"));
    // Crude markup check: react-dom/server emits `disabled=""` on
    // boolean attributes. Match either form.
    expect(html).toMatch(
      /data-testid="apply-button"[^>]*\bdisabled(?:=""|)/,
    );
  });
});

describe("AttachScreen — input wiring", () => {
  it("seeds the base-URL input from ctx.baseUrl", () => {
    const ctx: AttachContext = {
      state: "api_error",
      baseUrl: "http://api.example.com:8080",
      envelope: null,
    };
    const html = renderToStaticMarkup(
      <AttachScreen
        ctx={ctx}
        dispatch={vi.fn()}
        bridge={makeBridge()}
      />,
    );
    expect(html).toContain("http://api.example.com:8080");
  });
});
