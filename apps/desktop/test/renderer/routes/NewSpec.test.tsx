import { readFile } from "node:fs/promises";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FIXTURE_BANNER_LABEL } from "../../../src/renderer/fixtures/index.js";
import {
  closeNewSpecConfirmation,
  deriveTitleFromSpecBody,
  EMPTY_NEW_SPEC_FORM,
  M3_M4_DEFERRAL_COPY,
  NewSpec,
  openNewSpecConfirmation,
  validateNewSpecForm,
  type NewSpecFormState,
  type NewSpecFixtureState,
} from "../../../src/renderer/routes/NewSpec.js";

const VALID_FORM: NewSpecFormState = {
  repoRoot: "/repos/pm-go",
  specFile: "docs/spec.md",
  specBody: "# Build top-level routes\n\nRender the M2 route surfaces.",
  titleOverride: "",
  modalOpen: false,
};

const NEW_SPEC_ROUTE = path.resolve(
  __dirname,
  "../../../src/renderer/routes/NewSpec.tsx",
);

function render(initialState: NewSpecFormState = EMPTY_NEW_SPEC_FORM): string {
  return renderToStaticMarkup(<NewSpec initialState={initialState} />);
}

function renderVariant(fixtureState: NewSpecFixtureState): string {
  return renderToStaticMarkup(<NewSpec fixtureState={fixtureState} />);
}

function tagFor(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<[^>]+data-testid="${testId}"[^>]*>`),
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("NewSpec route", () => {
  it("renders the mock pickers, paste field, fixture banner, and top-level chrome only", () => {
    const html = render();

    expect(html).toMatch(/data-testid="new-spec-route"/);
    expect(html).toContain(FIXTURE_BANNER_LABEL);
    expect(html).toMatch(/data-testid="new-spec-repo-root"/);
    expect(html).toMatch(/data-testid="new-spec-spec-file"/);
    expect(html).toMatch(/data-testid="new-spec-body"/);
    expect(html).toMatch(/data-testid="new-spec-derived-title"/);
    expect(html).toMatch(/data-testid="new-spec-title-override"/);
    expect(html).not.toMatch(/data-testid="event-drawer"/);
    expect(html).not.toMatch(/data-testid="right-inspector"/);
  });

  it("keeps submit disabled and explains when repo root is missing", () => {
    const form: NewSpecFormState = {
      ...EMPTY_NEW_SPEC_FORM,
      specBody: "# Ready spec",
    };
    const validation = validateNewSpecForm(form);
    const html = render(form);

    expect(validation).toEqual({
      disabled: true,
      reason: "Pick a repository root before submitting.",
    });
    expect(tagFor(html, "new-spec-submit")).toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(html).toContain("Pick a repository root before submitting.");
    expect(html).not.toMatch(/data-testid="confirmation-modal"/);
  });

  it("keeps submit disabled and explains when spec body is missing", () => {
    const form: NewSpecFormState = {
      ...EMPTY_NEW_SPEC_FORM,
      repoRoot: "/repos/pm-go",
    };
    const validation = validateNewSpecForm(form);
    const html = render(form);

    expect(validation).toEqual({
      disabled: true,
      reason: "Paste or load a spec body before submitting.",
    });
    expect(tagFor(html, "new-spec-submit")).toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(html).toContain("Paste or load a spec body before submitting.");
    expect(html).not.toMatch(/data-testid="confirmation-modal"/);
  });

  it("derives a title from the spec body and lets the override win", () => {
    const derived = deriveTitleFromSpecBody(VALID_FORM.specBody);
    const overridden: NewSpecFormState = {
      ...VALID_FORM,
      titleOverride: "Operator supplied title",
    };
    const html = render(overridden);

    expect(derived).toBe("Build top-level routes");
    expect(html).toContain("Derived title:");
    expect(html).toContain("Build top-level routes");
    expect(html).toContain("Effective title:");
    expect(html).toContain("Operator supplied title");
    expect(tagFor(html, "new-spec-submit")).not.toMatch(/\sdisabled(?:=""|\s|>)/);
    expect(html).not.toMatch(/data-testid="new-spec-validation"/);
  });

  it("opens the confirmation modal on submit state and dismisses without changing form fields", () => {
    const open = openNewSpecConfirmation(VALID_FORM);
    const closed = closeNewSpecConfirmation(open);
    const html = render(open);

    expect(open).toEqual({ ...VALID_FORM, modalOpen: true });
    expect(closed).toEqual(VALID_FORM);
    expect(html).toMatch(/data-testid="confirmation-modal"/);
    expect(html).toContain("Create plan from spec");
    expect(html).toContain(M3_M4_DEFERRAL_COPY);
    expect(html).toContain("M4 will wire this to the API.");
    expect(html).toContain("Acknowledge");
    expect(html).toContain("Dismiss");
  });

  it.each([
    ["loading", "new-spec-loading"],
    ["empty", "new-spec-empty"],
    ["error", "new-spec-error"],
  ] satisfies Array<[NewSpecFixtureState, string]>)(
    "renders the %s fixture variant without mounting the form",
    (fixtureState, testId) => {
      const html = renderVariant(fixtureState);

      expect(html).toMatch(new RegExp(`data-fixture-state="${fixtureState}"`));
      expect(html).toContain(FIXTURE_BANNER_LABEL);
      expect(html).toMatch(new RegExp(`data-testid="${testId}"`));
      expect(html).not.toMatch(/data-testid="new-spec-repo-root"/);
      expect(html).not.toMatch(/data-testid="new-spec-submit"/);
      expect(html).not.toMatch(/data-testid="confirmation-modal"/);
    },
  );

  it("does not add direct API or bridge calls from this top-level route", async () => {
    const source = stripComments(await readFile(NEW_SPEC_ROUTE, "utf8"));

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bprobeHealth\s*\(/);
    expect(source).not.toMatch(/\bgetConfig\s*\(/);
    expect(source).not.toMatch(/\bsetApiBaseUrl\s*\(/);
  });
});
