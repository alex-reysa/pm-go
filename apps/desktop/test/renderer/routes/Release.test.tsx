import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  releaseEmptyState,
  releaseErrorState,
  releaseHappyPath,
  type FixtureDataset,
  type ReleaseView,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { Release } from "../../../src/renderer/routes/Release.js";

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

function renderRelease(
  dataset: FixtureDataset<ReleaseView>,
  initialReleaseConfirmationOpen = false,
): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs/plan_release/release"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.release" />}
        >
          <Route
            path="release"
            element={
              <Release
                dataset={dataset}
                initialReleaseConfirmationOpen={initialReleaseConfirmationOpen}
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Release route", () => {
  it.each([
    ["happy", releaseHappyPath],
    ["empty", releaseEmptyState],
    ["error", releaseErrorState],
  ])("mounts inside RunDetailShell on %s fixtures", (_state, dataset) => {
    const html = renderRelease(dataset);
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="release-route"');
  });

  it("renders readiness and opens the M4 release confirmation modal", () => {
    const html = renderRelease(releaseHappyPath, true);
    expect(html).toContain('data-testid="release-readiness"');
    expect(html).toContain('data-testid="release-button"');
    expect(html).toContain('data-testid="confirmation-modal"');
    expect(html).toContain("M4 will wire this to the API.");
    expect(html).toContain("Release plan plan_01HVQXBCC7D2GZREL3SE");
  });

  it("preserves run navigation and drawer context on simulated fixture errors", () => {
    const html = renderRelease(releaseErrorState);
    expect(html).toContain('data-testid="release-error"');
    expect(html).toContain('data-testid="navbar-link-run.release"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain("Show events");
  });
});
