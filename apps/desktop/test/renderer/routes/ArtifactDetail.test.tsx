import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  artifactDetailEmptyState,
  artifactDetailErrorState,
  artifactDetailHappyPath,
  type ArtifactDetail as ArtifactDetailView,
  type FixtureDataset,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { ArtifactDetail } from "../../../src/renderer/routes/ArtifactDetail.js";

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

function renderArtifactDetail(
  dataset: FixtureDataset<ArtifactDetailView | null>,
): string {
  return renderToStaticMarkup(
    <MemoryRouter
      initialEntries={["/runs/plan_artifacts/evidence/artifact_detail"]}
    >
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.artifactDetail" />}
        >
          <Route
            path="evidence/:artifactId"
            element={<ArtifactDetail dataset={dataset} />}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Artifact Detail route", () => {
  it.each([
    ["happy", artifactDetailHappyPath],
    ["empty", artifactDetailEmptyState],
    ["error", artifactDetailErrorState],
  ])("mounts inside RunDetailShell on %s fixtures", (_state, dataset) => {
    const html = renderArtifactDetail(dataset);
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="artifact-detail-route"');
  });

  it("renders artifact content inertly in a preformatted text container", () => {
    const html = renderArtifactDetail(artifactDetailHappyPath);
    expect(html).toContain('data-testid="artifact-detail-body"');
    expect(html).toMatch(
      /<pre[^>]*data-testid="artifact-detail-content"[^>]*>/,
    );
    expect(html).toContain("# Fixture module");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  it("preserves run navigation and drawer context on simulated fixture errors", () => {
    const html = renderArtifactDetail(artifactDetailErrorState);
    expect(html).toContain('data-testid="artifact-detail-error"');
    expect(html).toContain('data-current-route="run.artifactDetail"');
    expect(html).toContain('data-testid="navbar-link-run.evidence"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain("Show events");
  });
});
