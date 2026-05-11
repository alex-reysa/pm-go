import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import {
  phasesEmptyState,
  phasesErrorState,
  phasesHappyPath,
} from "../../../src/renderer/fixtures/index.js";
import { PlanPhases } from "../../../src/renderer/routes/PlanPhases.js";

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

function renderPlanPhases(element: React.ReactElement): string {
  return renderMarkup(
    <MemoryRouter initialEntries={["/runs/plan_01HVQX7AA4B0EXEC1NG/phases"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.phases" />}
        >
          <Route path="phases" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("PlanPhases route", () => {
  it("mounts in RunDetailShell with the collapsed event drawer affordance", () => {
    const html = renderPlanPhases(<PlanPhases dataset={phasesHappyPath} />);

    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-current-route="run.phases"');
    expect(html).toContain('data-testid="plan-phases"');
    expect(html).toContain('data-testid="plan-phases-list"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="right-inspector-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="event-drawer"');
    expect(html).not.toContain("Events stream wires up in M6.");
  });

  it("renders happy, empty, and error fixtures without throwing", () => {
    for (const dataset of [
      phasesHappyPath,
      phasesEmptyState,
      phasesErrorState,
    ]) {
      const html = renderPlanPhases(<PlanPhases dataset={dataset} />);
      expect(html).toContain('data-testid="plan-phases"');
      expect(html).toContain(`data-dataset-state="${dataset.state}"`);
    }

    const emptyHtml = renderPlanPhases(<PlanPhases dataset={phasesEmptyState} />);
    expect(emptyHtml).toContain('data-testid="plan-phases-empty"');

    const errorHtml = renderPlanPhases(<PlanPhases dataset={phasesErrorState} />);
    expect(errorHtml).toContain('data-testid="plan-phases-error"');
  });
});
