import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  budgetEmptyState,
  budgetErrorState,
  budgetHappyPath,
  type BudgetSnapshot,
  type FixtureDataset,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { Budget } from "../../../src/renderer/routes/Budget.js";

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

function renderBudget(dataset: FixtureDataset<BudgetSnapshot>): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs/plan_budget/budget"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.budget" />}
        >
          <Route path="budget" element={<Budget dataset={dataset} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Budget route", () => {
  it.each([
    ["happy", budgetHappyPath],
    ["empty", budgetEmptyState],
    ["error", budgetErrorState],
  ])("mounts inside RunDetailShell on %s fixtures", (_state, dataset) => {
    const html = renderBudget(dataset);
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="budget-route"');
  });

  it("renders plan summary, task pressure, phase pressure, and policy links", () => {
    const html = renderBudget(budgetHappyPath);
    expect(html).toContain('data-testid="budget-summary"');
    expect(html).toContain('data-testid="budget-phase-pressure"');
    expect(html).toContain("Per-route surfaces");
    expect(html).toContain('data-testid="budget-policy-approvals-link"');
    expect(html).toContain('data-testid="budget-policy-tasks-link"');
    expect(html).toContain(
      'data-testid="budget-row-task_01HVQX9001FIXTURES000"',
    );
  });

  it("preserves run navigation and drawer context on simulated fixture errors", () => {
    const html = renderBudget(budgetErrorState);
    expect(html).toContain('data-testid="budget-error"');
    expect(html).toContain('data-testid="navbar-link-run.budget"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain("Show events");
  });
});
