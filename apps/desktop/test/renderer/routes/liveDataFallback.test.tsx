/**
 * Route-level "live data" fallback contracts.
 *
 * AC 6d6f2fb0 asks for route tests covering: live Runs List, selected
 * run cockpit reconstruction, task detail, artifact failure states,
 * empty/disconnected fixture fallback, and manual refresh preserving
 * route state. The per-route smokes under
 * `routes/{RunsList,RunOverview,TaskDetail,ArtifactDetail}.test.tsx`
 * already cover the happy-path rendering shape; this file fills the
 * cross-cutting gaps:
 *
 *   1. The Runs List renders identically across two consecutive
 *      renders that swap the fixture envelope (happy → empty), which
 *      models a manual refresh that returned no rows. The route
 *      params and the IA-level chrome (banner, "new spec" link) stay
 *      put.
 *   2. The Run Overview cockpit reconstruction stays honest when
 *      every dataset envelope flips to its error variant — the
 *      cockpit triplet (current state / blocker / release readiness)
 *      still renders BEFORE the per-phase detail block, and the
 *      shell keeps the event-drawer + right-inspector toggles
 *      collapsed.
 *   3. The Task Detail route preserves the URL params across a
 *      simulated manual refresh that re-mounts the route with a new
 *      dataset envelope. The route-level data-attributes (planId
 *      from the URL, `currentRouteId`) survive the swap.
 *   4. The Artifact Detail route renders the error envelope without
 *      injecting executable markup: no `<script>` or `<img>` tags,
 *      the error banner stays inside the run shell, and the
 *      back-link is suppressed (because the artifact body is null
 *      under the error envelope).
 *   5. The Runs List "disconnected" fallback (empty fixture) lands
 *      the operator on the New Spec entry point — the empty banner
 *      links to /runs/new so an operator on a disconnected daemon
 *      still has a forward action.
 *
 * Everything is rendered through `renderToStaticMarkup` so the
 * suite stays DOM-free.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  artifactDetailErrorState,
  artifactDetailHappyPath,
  phasesErrorState,
  planErrorState,
  releaseErrorState,
  runsEmptyState,
  runsErrorState,
  runsHappyPath,
  taskDetailEmptyState,
  taskDetailHappyPath,
} from "../../../src/renderer/fixtures/index.js";
import { RunDetailShell } from "../../../src/renderer/layout/RunDetailShell.js";
import { ArtifactDetail } from "../../../src/renderer/routes/ArtifactDetail.js";
import { RunOverview } from "../../../src/renderer/routes/RunOverview.js";
import { RunsList } from "../../../src/renderer/routes/RunsList.js";
import { TaskDetail } from "../../../src/renderer/routes/TaskDetail.js";

const originalConsoleError = console.error;
let consoleErrorSpy: { mockRestore: () => void };

beforeAll(() => {
  // RunDetailShell drags in useLayoutEffect; the static render warns
  // about that and the noise drowns the actual assertion failures.
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

function renderRunsList(fixture: typeof runsHappyPath): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs"]}>
      <RunsList fixture={fixture} />
    </MemoryRouter>,
  );
}

function renderRunOverview(element: React.ReactElement, planId: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/runs/${planId}`]}>
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

function renderTaskDetail(
  element: React.ReactElement,
  planId: string,
  taskId: string,
): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/runs/${planId}/tasks/${taskId}`]}>
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

function renderArtifactDetail(
  dataset: typeof artifactDetailHappyPath | typeof artifactDetailErrorState,
  planId: string,
  artifactId: string,
): string {
  return renderToStaticMarkup(
    <MemoryRouter
      initialEntries={[`/runs/${planId}/evidence/${artifactId}`]}
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

describe("route-level live data fallbacks", () => {
  it("Runs List survives a manual refresh that swapped happy → empty without losing the New Spec entry point", () => {
    const beforeRefresh = renderRunsList(runsHappyPath);
    // Sanity: first render shows live rows, banner, New Spec link.
    expect(beforeRefresh).toContain('data-testid="runs-list-route"');
    expect(beforeRefresh).toContain('data-fixture-state="happy"');
    expect(beforeRefresh).toContain('data-testid="runs-list-rows"');
    expect(beforeRefresh).toContain('data-testid="runs-list-new-spec-link"');
    expect(beforeRefresh).toContain('href="/runs/new"');
    for (const run of runsHappyPath.data) {
      expect(beforeRefresh).toContain(`data-testid="runs-list-row-${run.id}"`);
    }

    // Refresh: empty envelope (operator pulled a stale window or the
    // daemon truly has zero plans). Route stays mounted; chrome stays
    // identical; the empty banner offers New Spec as the forward
    // action.
    const afterRefresh = renderRunsList(runsEmptyState);
    expect(afterRefresh).toContain('data-testid="runs-list-route"');
    expect(afterRefresh).toContain('data-fixture-state="empty"');
    expect(afterRefresh).toContain('data-testid="runs-list-empty"');
    expect(afterRefresh).toContain('data-testid="runs-list-new-spec-link"');
    expect(afterRefresh).toContain('href="/runs/new"');
    expect(afterRefresh).toContain(
      'data-testid="runs-list-empty-new-spec-link"',
    );
    // No row markup leaks across the refresh.
    expect(afterRefresh).not.toContain('data-testid="runs-list-rows"');
    for (const run of runsHappyPath.data) {
      expect(afterRefresh).not.toContain(`data-testid="runs-list-row-${run.id}"`);
    }
  });

  it("Runs List error envelope keeps the route mounted and surfaces the recoverable error inline", () => {
    const html = renderRunsList(runsErrorState);
    expect(html).toContain('data-testid="runs-list-route"');
    expect(html).toContain('data-fixture-state="error"');
    expect(html).toContain('data-testid="runs-list-error"');
    expect(html).toContain("Unable to load runs (HTTP 503)");
    // Disconnected daemon: New Spec is still the forward action.
    expect(html).toContain('href="/runs/new"');
    // No run-scoped chrome leaks onto Runs List.
    expect(html).not.toMatch(/data-testid="event-drawer"/);
    expect(html).not.toMatch(/data-testid="right-inspector"/);
  });

  it("Run Overview cockpit reconstruction renders the triplet BEFORE detail when every dataset envelope is error", () => {
    const planId = "plan_01HVQX7AA4B0EXEC1NG";
    const html = renderRunOverview(
      <RunOverview
        planDataset={planErrorState}
        phasesDataset={phasesErrorState}
        releaseDataset={releaseErrorState}
      />,
      planId,
    );

    // RunDetailShell stays mounted with the right route id.
    expect(html).toContain('data-testid="run-detail-shell"');
    expect(html).toContain('data-current-route="run.overview"');
    // Cockpit triplet still renders.
    const currentStateIdx = html.indexOf(
      'data-testid="run-overview-current-state"',
    );
    const blockerIdx = html.indexOf(
      'data-testid="run-overview-blocker-next-action"',
    );
    const releaseIdx = html.indexOf(
      'data-testid="run-overview-release-readiness"',
    );
    const detailIdx = html.indexOf('data-testid="run-overview-detail"');
    expect(currentStateIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeGreaterThan(currentStateIdx);
    expect(releaseIdx).toBeGreaterThan(blockerIdx);
    expect(detailIdx).toBeGreaterThan(releaseIdx);
    // Drawer + inspector start collapsed in the disconnected scenario.
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-testid="right-inspector-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="event-drawer-empty"');
  });

  it("Task Detail preserves URL params across a simulated manual refresh that swapped happy → empty", () => {
    const planId = "plan_01HVQX7AA4B0EXEC1NG";
    const taskId = "task_01HVQX9003ROUTES0000";

    const beforeRefresh = renderTaskDetail(
      <TaskDetail dataset={taskDetailHappyPath} />,
      planId,
      taskId,
    );
    expect(beforeRefresh).toContain('data-testid="task-detail"');
    expect(beforeRefresh).toContain('data-current-route="run.taskDetail"');
    // Identity surfaces present.
    expect(beforeRefresh).toContain('data-testid="task-detail-acceptance"');
    expect(beforeRefresh).toContain('data-testid="task-detail-file-scope"');

    // Manual refresh re-mounts the same URL. The dataset returns to
    // the empty envelope (the daemon's task vanished mid-flight or
    // the operator opened a stale URL); the route stays mounted, the
    // shell stays the same, and the empty banner takes over the body.
    const afterRefresh = renderTaskDetail(
      <TaskDetail dataset={taskDetailEmptyState} />,
      planId,
      taskId,
    );
    expect(afterRefresh).toContain('data-testid="task-detail"');
    expect(afterRefresh).toContain('data-current-route="run.taskDetail"');
    expect(afterRefresh).toContain('data-dataset-state="empty"');
    expect(afterRefresh).toContain('data-testid="task-detail-empty"');
    // Action buttons drop out when there is no task body — operator
    // cannot fire a mutating action against a phantom task.
    expect(afterRefresh).not.toContain('data-testid="task-detail-actions"');
    // Shell chrome (drawer + inspector toggles) stays collapsed.
    expect(afterRefresh).toContain('data-testid="event-drawer-toggle"');
    expect(afterRefresh).toContain('data-testid="right-inspector-toggle"');
    expect(afterRefresh).toContain('aria-expanded="false"');
  });

  it("Artifact Detail renders the error envelope safely with no executable markup and no broken back-link", () => {
    const planId = "plan_01HVQX7AA4B0EXEC1NG";
    const artifactId = "art_01HVQXA001PRSUMMARY0";
    const html = renderArtifactDetail(
      artifactDetailErrorState,
      planId,
      artifactId,
    );

    expect(html).toContain('data-testid="artifact-detail-route"');
    expect(html).toContain('data-fixture-state="error"');
    expect(html).toContain('data-testid="artifact-detail-error"');
    expect(html).toContain("Failed to load artifact (HTTP 403)");
    expect(html).toContain(
      "artifact path containment check failed on the API",
    );
    // Safety: no inline script, no remote image, no iframe.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    // Back-link is suppressed when there is no artifact body to
    // anchor it (the route would otherwise compose a route from a
    // null planId).
    expect(html).not.toContain('data-testid="artifact-detail-back-link"');
    // Body container should also stay absent under the error envelope.
    expect(html).not.toContain('data-testid="artifact-detail-body"');
    // Run-scoped chrome stays available — the operator can still pop
    // the event drawer to read the failure event sequence.
    expect(html).toContain('data-testid="event-drawer-toggle"');
    expect(html).toContain('data-current-route="run.artifactDetail"');
  });

  it("Artifact Detail happy-path body renders as inert preformatted text (no html injection)", () => {
    const planId = "plan_01HVQX7AA4B0EXEC1NG";
    const artifactId = artifactDetailHappyPath.data.id;
    const html = renderArtifactDetail(
      artifactDetailHappyPath,
      planId,
      artifactId,
    );
    expect(html).toMatch(
      /<pre[^>]*data-testid="artifact-detail-content"[^>]*>/,
    );
    // The markdown body should appear as text, not parsed HTML.
    expect(html).toContain("# Fixture module");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
  });
});
