import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import {
  taskDetailEmptyState,
  taskDetailErrorState,
  taskDetailHappyPath,
} from "../../../src/renderer/fixtures/index.js";
import {
  ACTION_LABELS,
  TASK_ACTION_KINDS,
  TaskDetail,
  type TaskActionKind,
} from "../../../src/renderer/routes/TaskDetail.js";

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

function renderTaskDetail(element: React.ReactElement): string {
  return renderMarkup(
    <MemoryRouter
      initialEntries={[
        "/runs/plan_01HVQX7AA4B0EXEC1NG/tasks/task_01HVQX9003ROUTES0000",
      ]}
    >
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.taskDetail" />}
        >
          <Route path="tasks/:taskId" element={element} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function renderPendingAction(kind: TaskActionKind): string {
  return renderTaskDetail(
    <TaskDetail dataset={taskDetailHappyPath} initialPendingAction={kind} />,
  );
}

describe("TaskDetail route", () => {
  it("mounts in RunDetailShell and renders task identity surfaces", () => {
    const html = renderTaskDetail(<TaskDetail dataset={taskDetailHappyPath} />);

    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-current-route="run.taskDetail"');
    expect(html).toContain('data-testid="task-detail"');
    expect(html).toContain('data-testid="task-detail-file-scope"');
    expect(html).toContain('data-testid="task-detail-acceptance"');
    expect(html).toContain('data-testid="task-detail-review"');
    expect(html).toContain('data-testid="task-detail-actions"');
    expect(html).toContain('data-testid="task-detail-open-inspector"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="right-inspector-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="event-drawer"');
  });

  it("renders empty and error fixtures without throwing", () => {
    const emptyHtml = renderTaskDetail(
      <TaskDetail dataset={taskDetailEmptyState} />,
    );
    expect(emptyHtml).toContain('data-dataset-state="empty"');
    expect(emptyHtml).toContain('data-testid="task-detail-empty"');

    const errorHtml = renderTaskDetail(
      <TaskDetail dataset={taskDetailErrorState} />,
    );
    expect(errorHtml).toContain('data-dataset-state="error"');
    expect(errorHtml).toContain('data-testid="task-detail-error"');
  });

  it("renders every mutating action button with label and disabled state", () => {
    const html = renderTaskDetail(<TaskDetail dataset={taskDetailHappyPath} />);

    for (const kind of TASK_ACTION_KINDS) {
      expect(html).toContain(`data-testid="task-detail-action-${kind}"`);
      expect(html).toContain(ACTION_LABELS[kind]);
    }
    expect(html).toContain(
      'data-testid="task-detail-action-task.approve" data-action="task.approve" data-action-disabled="false"',
    );
    expect(html).toContain(
      'data-testid="task-detail-action-reason-task.run"',
    );
    expect(html).toContain(
      "This action is not available for the task in its current state.",
    );
    expect(html).not.toContain('data-testid="confirmation-modal"');
  });

  it("opens the confirmation modal copy for each mutating action", () => {
    for (const kind of TASK_ACTION_KINDS) {
      const html = renderPendingAction(kind);
      const label = ACTION_LABELS[kind];

      expect(html).toContain('data-testid="confirmation-modal"');
      expect(html).toContain(`>${label}</h2>`);
      expect(html).toContain(`Action: ${label}`);
      expect(html).toContain('data-testid="confirmation-modal-m4-copy"');
      expect(html).toContain("M4 will wire this to the API.");
      expect(html).toContain('data-testid="confirmation-modal-cancel"');
    }
  });

  it("shows disabled-reason copy in the modal when an action is not allowed", () => {
    const html = renderPendingAction("task.review");

    expect(html).toContain('data-testid="confirmation-modal-disabled-reason"');
    expect(html).toContain(
      "This action is not available for the task in its current state.",
    );
    expect(html).toContain('data-testid="confirmation-modal-confirm"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
  });
});
