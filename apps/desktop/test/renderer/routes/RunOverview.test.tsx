import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import {
  phasesErrorState,
  planErrorState,
  planHappyPath,
  releaseErrorState,
  releaseHappyPath,
} from "../../../src/renderer/fixtures/index.js";
import { RunOverview } from "../../../src/renderer/routes/RunOverview.js";

function renderMarkup(element: React.ReactElement): string {
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    const [firstArg] = args;
    if (
      typeof firstArg === "string" &&
      firstArg.includes("useLayoutEffect does nothing on the server")
    ) {
      return;
    }
    originalError(...args);
  };
  try {
    return renderToStaticMarkup(element);
  } finally {
    console.error = originalError;
  }
}

function renderOverview(element: React.ReactElement): string {
  return renderMarkup(
    <MemoryRouter initialEntries={["/runs/plan_01HVQX7AA4B0EXEC1NG"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.overview" />}
        >
          <Route index element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunOverview route", () => {
  it("renders cockpit sections before per-phase task detail", () => {
    const html = renderOverview(<RunOverview />);

    const currentStateIndex = html.indexOf(
      'data-testid="run-overview-current-state"',
    );
    const blockerIndex = html.indexOf(
      'data-testid="run-overview-blocker-next-action"',
    );
    const releaseIndex = html.indexOf(
      'data-testid="run-overview-release-readiness"',
    );
    const detailIndex = html.indexOf('data-testid="run-overview-detail"');

    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="right-inspector-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="event-drawer-empty"');
    expect(currentStateIndex).toBeGreaterThan(-1);
    expect(blockerIndex).toBeGreaterThan(currentStateIndex);
    expect(releaseIndex).toBeGreaterThan(blockerIndex);
    expect(detailIndex).toBeGreaterThan(releaseIndex);
  });

  it("keeps the route visible for fixture error variants", () => {
    const html = renderOverview(
      <RunOverview
        planDataset={planErrorState}
        phasesDataset={phasesErrorState}
        releaseDataset={releaseErrorState}
      />,
    );

    expect(html).toContain('data-testid="run-overview"');
    expect(html).toContain('data-dataset-state="error"');
    expect(html).toContain('data-testid="run-overview-plan-error"');
    expect(html).toContain('data-testid="run-overview-phases-error"');
    expect(html).toContain('data-testid="run-overview-release-error"');
    expect(html).toContain('data-testid="run-overview-current-state"');
  });

  it("does not recommend release while the plan is still executing", () => {
    const html = renderOverview(
      <RunOverview
        planDataset={planHappyPath}
        releaseDataset={releaseHappyPath}
      />,
    );

    expect(html).toContain(
      "Next action: Wait for the active task to finish.",
    );
    expect(html).not.toContain("Next action: Release the plan.");
  });

  it("only recommends release for a completed plan with a passing audit", () => {
    const completedPlanDataset = {
      ...planHappyPath,
      data: {
        ...planHappyPath.data,
        status: "completed" as const,
      },
    };
    const html = renderOverview(
      <RunOverview
        planDataset={completedPlanDataset}
        releaseDataset={releaseHappyPath}
      />,
    );

    expect(html).toContain("Next action: Release the plan.");
  });
});
