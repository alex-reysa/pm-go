import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import {
  tasksEmptyState,
  tasksErrorState,
  tasksHappyPath,
} from "../../../src/renderer/fixtures/index.js";
import { Tasks } from "../../../src/renderer/routes/Tasks.js";

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

function renderTasks(element: React.ReactElement): string {
  return renderMarkup(
    <MemoryRouter initialEntries={["/runs/plan_01HVQX7AA4B0EXEC1NG/tasks"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.tasks" />}
        >
          <Route path="tasks" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Tasks route", () => {
  it("mounts in RunDetailShell with filters, phase groups, and collapsed drawer", () => {
    const html = renderTasks(<Tasks tasksDataset={tasksHappyPath} />);

    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-current-route="run.tasks"');
    expect(html).toContain('data-testid="tasks-filters"');
    expect(html).toContain('data-testid="tasks-filter-status"');
    expect(html).toContain('data-testid="tasks-groups"');
    expect(html).toContain(
      'data-testid="tasks-group-phase_01HVQX8001FOUNDATION0"',
    );
    expect(html).toContain(
      'data-testid="tasks-row-inspect-task_01HVQX9001FIXTURES000"',
    );
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="right-inspector-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="event-drawer"');
    expect(html).not.toContain("Events stream wires up in M6.");
  });

  it("renders happy, empty, and error fixtures without throwing", () => {
    for (const dataset of [tasksHappyPath, tasksEmptyState, tasksErrorState]) {
      const html = renderTasks(<Tasks tasksDataset={dataset} />);
      expect(html).toContain('data-testid="tasks"');
      expect(html).toContain(`data-dataset-state="${dataset.state}"`);
    }

    const emptyHtml = renderTasks(<Tasks tasksDataset={tasksEmptyState} />);
    expect(emptyHtml).toContain('data-testid="tasks-empty"');

    const errorHtml = renderTasks(<Tasks tasksDataset={tasksErrorState} />);
    expect(errorHtml).toContain('data-testid="tasks-error"');
  });

  it("renders a no-match state for an active status filter", () => {
    const html = renderTasks(
      <Tasks tasksDataset={tasksHappyPath} initialStatusFilter="failed" />,
    );

    expect(html).toContain('data-status-filter="failed"');
    expect(html).toContain('data-testid="tasks-no-matches"');
  });
});
