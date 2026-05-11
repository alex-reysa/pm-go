import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  approvalsEmptyState,
  approvalsErrorState,
  approvalsHappyPath,
  type ApprovalsList,
  type FixtureDataset,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { Approvals } from "../../../src/renderer/routes/Approvals.js";

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

function renderApprovals(
  dataset: FixtureDataset<ApprovalsList>,
  initialPendingConfirmationId?: string,
): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs/plan_approvals/approvals"]}>
      <Routes>
        <Route
          path="/runs/:planId"
          element={<RunDetailShell currentRouteId="run.approvals" />}
        >
          <Route
            path="approvals"
            element={
              <Approvals
                dataset={dataset}
                initialPendingConfirmationId={
                  initialPendingConfirmationId ?? null
                }
              />
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Approvals route", () => {
  it.each([
    ["happy", approvalsHappyPath],
    ["empty", approvalsEmptyState],
    ["error", approvalsErrorState],
  ])("mounts inside RunDetailShell on %s fixtures", (_state, dataset) => {
    const html = renderApprovals(dataset);
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="approvals-route"');
  });

  it("renders approval context and opens the M4 confirmation modal for pending approvals", () => {
    const pendingId = approvalsHappyPath.data[0]?.id;
    expect(pendingId).toBeDefined();
    const html = renderApprovals(approvalsHappyPath, pendingId);
    expect(html).toContain(`data-testid="approvals-approve-${pendingId}"`);
    expect(html).toContain('data-testid="confirmation-modal"');
    expect(html).toContain("M4 will wire this to the API.");
    expect(html).toContain("Risk medium");
  });

  it("preserves run navigation and drawer context on simulated fixture errors", () => {
    const html = renderApprovals(approvalsErrorState);
    expect(html).toContain('data-testid="approvals-error"');
    expect(html).toContain('data-testid="navbar-link-run.approvals"');
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain("Show events");
  });
});
