/**
 * Shell-level route smokes for the phase-0 desktop router.
 *
 * These tests stay DOM-free by rendering the route tree under
 * React Router's server-safe StaticRouter. They assert the IA-level
 * contracts that matter before route bodies become data-backed:
 * top-level routes mount, prototype Dashboard routing is absent, and
 * run-scoped affordances do not leak onto Attach / Runs / New Spec /
 * Settings.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server.js";
import { describe, expect, it } from "vitest";

import {
  AppRoutes,
  POST_ATTACH_LANDING_PATH,
} from "../../../src/renderer/App.js";
import {
  ALL_ROUTES,
  ROUTES,
  type RouteDescriptor,
  type RouteId,
} from "../../../src/renderer/router/index.js";

interface RouteCase {
  readonly label: string;
  readonly path: string;
  readonly routeId: RouteId;
}

const TOP_LEVEL_ROUTE_CASES: readonly RouteCase[] = [
  { label: "Attach", path: ROUTES.attach.path, routeId: "attach" },
  { label: "Runs List", path: ROUTES.runs.path, routeId: "runs" },
  { label: "New Spec", path: ROUTES["runs.new"].path, routeId: "runs.new" },
  { label: "Settings", path: ROUTES.settings.path, routeId: "settings" },
];

function renderRoute(path: string): string {
  return renderToStaticMarkup(
    <StaticRouter location={path}>
      <AppRoutes />
    </StaticRouter>,
  );
}

function concretePath(descriptor: RouteDescriptor): string {
  return descriptor.path
    .replace(":planId", "plan-alpha")
    .replace(":taskId", "task-compile")
    .replace(":artifactId", "artifact-review");
}

function expectedRouteMarker(routeId: RouteId): string {
  if (routeId === "runs") {
    return 'data-testid="runs-placeholder"';
  }
  return `data-testid="route-${routeId}"`;
}

describe("phase-0 route shell", () => {
  it("keeps the event drawer absent from Attach, Runs List, New Spec, and Settings", () => {
    for (const route of TOP_LEVEL_ROUTE_CASES) {
      const html = renderRoute(route.path);
      expect(html, route.label).not.toContain('data-testid="event-drawer"');
      expect(html, route.label).not.toContain(
        'data-testid="event-drawer-toggle"',
      );
    }
  });

  it("does not render a permanent right inspector on Attach, Runs List, New Spec, or Settings", () => {
    for (const route of TOP_LEVEL_ROUTE_CASES) {
      const html = renderRoute(route.path);
      expect(html, route.label).not.toContain('data-testid="right-inspector"');
      expect(html, route.label).not.toContain(
        'data-testid="right-inspector-toggle"',
      );
    }
  });

  it("lands post-attach navigation on /runs, not a prototype Dashboard", () => {
    expect(POST_ATTACH_LANDING_PATH).toBe(ROUTES.runs.path);
    expect(POST_ATTACH_LANDING_PATH).not.toMatch(/dashboard/i);
    const html = renderRoute(POST_ATTACH_LANDING_PATH);
    expect(html).toContain('data-testid="runs-placeholder"');
    expect(html).not.toMatch(/Dashboard/i);
  });

  it("mounts every top-level route without throwing", () => {
    for (const route of TOP_LEVEL_ROUTE_CASES) {
      const html = renderRoute(route.path);
      expect(html, route.label).toContain('data-testid="app-shell"');
      expect(html, route.label).toContain(expectedRouteMarker(route.routeId));
      expect(html, route.label).not.toContain('data-testid="route-not-found"');
    }
  });

  it("mounts every route descriptor without falling through to not found", () => {
    for (const descriptor of ALL_ROUTES) {
      const path = concretePath(descriptor);
      const html = renderRoute(path);
      expect(html, descriptor.id).toContain(expectedRouteMarker(descriptor.id));
      expect(html, descriptor.id).not.toContain(
        'data-testid="route-not-found"',
      );
    }
  });
});
