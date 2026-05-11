import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  evidenceEmptyState,
  evidenceErrorState,
  evidenceHappyPath,
  type EvidenceBundleView,
  type FixtureDataset,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { Evidence } from "../../../src/renderer/routes/Evidence.js";

const originalConsoleError = console.error;
let consoleErrorSpy: { mockRestore: () => void };

beforeAll(() => {
  consoleErrorSpy = vi
    .spyOn(console, "error")
    .mockImplementation((message?: unknown, ...args: unknown[]) => {
      if (
        typeof message === "string" &&
        message.includes("useLayoutEffect does nothing on the server")
      ) {
        return;
      }
      originalConsoleError(message, ...args);
    });
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

function renderEvidence(dataset: FixtureDataset<EvidenceBundleView>): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs/plan_evidence/evidence"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.evidence" />}
        >
          <Route path="evidence" element={<Evidence dataset={dataset} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Evidence route", () => {
  it.each([
    ["happy", evidenceHappyPath],
    ["empty", evidenceEmptyState],
    ["error", evidenceErrorState],
  ])("mounts inside RunDetailShell on %s fixtures", (_state, dataset) => {
    const html = renderEvidence(dataset);
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="evidence-route"');
  });

  it("renders audits, findings, and artifact groups by context", () => {
    const html = renderEvidence(evidenceHappyPath);
    expect(html).toContain('data-testid="evidence-audit"');
    expect(html).toContain('data-testid="evidence-findings"');
    expect(html).toContain('data-testid="evidence-artifact-group-audits"');
    expect(html).toContain('data-testid="evidence-artifact-group-reviews"');
    expect(html).toContain('data-testid="evidence-artifact-group-release"');
    expect(html).toContain("Completion evidence bundle");
    expect(html).toContain("<pre");
  });

  it("preserves run navigation and drawer context on simulated fixture errors", () => {
    const html = renderEvidence(evidenceErrorState);
    expect(html).toContain('data-testid="evidence-error"');
    expect(html).toContain('data-testid="navbar-link-run.evidence"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain("Show events");
  });
});
