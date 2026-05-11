import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import {
  FIXTURE_BANNER_LABEL,
  runsEmptyState,
  runsErrorState,
  runsHappyPath,
  type RunsList as RunsListData,
  type FixtureDataset,
} from "../../../src/renderer/fixtures/index.js";
import { RunsList } from "../../../src/renderer/routes/RunsList.js";

function render(fixture: FixtureDataset<RunsListData>): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/runs"]}>
      <RunsList fixture={fixture} />
    </MemoryRouter>,
  );
}

function expectNoRunScopedChrome(html: string): void {
  expect(html).not.toMatch(/data-testid="event-drawer"/);
  expect(html).not.toMatch(/data-testid="right-inspector"/);
}

function escapeTextForStaticMarkup(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

describe("RunsList route", () => {
  it("renders the happy-path fixture with attention indicators and navigation", () => {
    const html = render(runsHappyPath);

    expect(html).toMatch(/data-testid="runs-list-route"/);
    expect(html).toContain(FIXTURE_BANNER_LABEL);
    expect(html).toContain(runsHappyPath.label);
    expect(html).toMatch(/data-testid="runs-list-new-spec-link"/);
    expect(html).toContain('href="/runs/new"');

    for (const run of runsHappyPath.data) {
      expect(html).toContain(`data-testid="runs-list-row-${run.id}"`);
      expect(html).toContain(escapeTextForStaticMarkup(run.title));
      expect(html).toContain(`href="/runs/${run.id}"`);
    }

    expect(html).toContain("1 pending approval");
    expect(html).toContain("2 pending approvals");
    expect(html).toContain("release ready");
    expect(html).toContain("3 blocked tasks");
    expect(html).toContain("1 failed task");
    expectNoRunScopedChrome(html);
  });

  it("renders the empty fixture without throwing and points to New Spec", () => {
    const html = render(runsEmptyState);

    expect(html).toContain('data-fixture-state="empty"');
    expect(html).toContain(FIXTURE_BANNER_LABEL);
    expect(html).toContain(runsEmptyState.label);
    expect(html).toMatch(/data-testid="runs-list-empty"/);
    expect(html).toContain("No runs yet.");
    expect(html).toContain('href="/runs/new"');
    expect(html).not.toMatch(/data-testid="runs-list-rows"/);
    expectNoRunScopedChrome(html);
  });

  it("renders the error fixture without throwing and keeps the list top-level", () => {
    const html = render(runsErrorState);

    expect(html).toContain('data-fixture-state="error"');
    expect(html).toContain(FIXTURE_BANNER_LABEL);
    expect(html).toContain(runsErrorState.label);
    expect(html).toMatch(/data-testid="runs-list-error"/);
    expect(html).toContain("Unable to load runs (HTTP 503)");
    expect(html).toContain("service unavailable while fetching /plans");
    expect(html).toMatch(/data-testid="runs-list-empty"/);
    expectNoRunScopedChrome(html);
  });
});
