/**
 * New Spec — the top-level entry point for kicking off a fresh plan.
 *
 * Information architecture (docs/desktop/03-information-architecture.md
 * §Route Map row `/runs/new`):
 *
 *   - Top-level route. No EventDrawer, no RightInspector — both belong
 *     to {@link RunDetailShell} and never mount here. Smoke tests
 *     assert their absence from this route's rendered markup.
 *   - The route makes NO API calls of its own at M2. Submit opens a
 *     {@link ConfirmationModal} that explains M3/M4 will wire the
 *     actual plan-creation pipeline. The modal dismisses without
 *     effect — there is no `POST /plans` plumbing here.
 *   - Inline validation gates the submit button: a missing repo root
 *     or a missing spec body leaves the button disabled, and the
 *     reason is rendered next to the button.
 *   - The page renders mock pickers (a repo-root `<select>` and a
 *     spec-file `<select>`) so the IA can be reviewed end-to-end
 *     without a real file-picker bridge. M3/M4 replaces those with
 *     real OS file dialogs through the bridge.
 *   - A derived title appears under the spec body — the first non-
 *     empty line, stripped of any markdown heading prefix, capped at
 *     80 characters. The operator can override the derived title with
 *     a free-text input; the override wins when non-empty.
 *
 * State is owned via `useState`. Tests use the {@link NewSpecProps.initialState}
 * seam to pre-seed the form so each variant (empty / valid / modal-open)
 * can be rendered without firing client-side events through jsdom.
 */

import React, { useState } from "react";

import { FIXTURE_BANNER_LABEL } from "../fixtures/index.js";
import { ConfirmationModal } from "../layout/index.js";
import { ROUTES } from "../router/index.js";

/**
 * Literal copy required by acceptance criterion 71a00002. The modal's
 * built-in M4 placeholder copy is appended automatically by the
 * {@link ConfirmationModal} primitive; this string is the route-
 * specific M3/M4 deferral explanation that the body renders alongside.
 */
export const M3_M4_DEFERRAL_COPY =
  "M3/M4 will wire this to the planner — no plan is created today.";

/**
 * Mock repo-root options. M3 swaps this for a real bridge-backed file
 * dialog; for now we hard-code a handful of plausible paths so the IA
 * can be reviewed end-to-end.
 */
export const REPO_ROOT_OPTIONS: readonly string[] = [
  "/repos/pm-go",
  "/repos/example-app",
  "/repos/sandbox",
];

/**
 * Mock spec-file options. The literal `(paste below)` value is the
 * deliberate "no file" sentinel — operators pasting an inline spec
 * pick this option so the picker doesn't claim a file is loaded.
 */
export const SPEC_FILE_OPTIONS: readonly string[] = [
  "docs/spec.md",
  "specs/feature.md",
  "(paste below)",
];

/**
 * Mutable form state for the route. The {@link NewSpecProps.initialState}
 * test seam accepts a partial of this shape to pre-seed individual
 * fields without forcing tests to spell out the whole object.
 */
export interface NewSpecFormState {
  readonly repoRoot: string;
  readonly specFile: string;
  readonly specBody: string;
  readonly titleOverride: string;
  readonly modalOpen: boolean;
}

export const EMPTY_NEW_SPEC_FORM: NewSpecFormState = Object.freeze({
  repoRoot: "",
  specFile: "",
  specBody: "",
  titleOverride: "",
  modalOpen: false,
});

export interface NewSpecValidation {
  readonly disabled: boolean;
  readonly reason: string | null;
}

export type NewSpecFixtureState = "happy" | "loading" | "empty" | "error";

/**
 * Pure helper: decide whether the submit button is enabled, and if
 * not, why. Exported so tests can drive it directly without rendering
 * the component.
 */
export function validateNewSpecForm(
  form: Pick<NewSpecFormState, "repoRoot" | "specBody">,
): NewSpecValidation {
  if (form.repoRoot.trim() === "") {
    return {
      disabled: true,
      reason: "Pick a repository root before submitting.",
    };
  }
  if (form.specBody.trim() === "") {
    return {
      disabled: true,
      reason: "Paste or load a spec body before submitting.",
    };
  }
  return { disabled: false, reason: null };
}

/**
 * Pure state transitions for the modal lifecycle. The component uses
 * these same helpers in its click handlers; tests assert the open /
 * dismiss behavior without requiring a DOM event harness.
 */
export function openNewSpecConfirmation(
  form: NewSpecFormState,
): NewSpecFormState {
  return { ...form, modalOpen: true };
}

export function closeNewSpecConfirmation(
  form: NewSpecFormState,
): NewSpecFormState {
  return { ...form, modalOpen: false };
}

/**
 * Pure helper: derive a default plan title from the spec body. Take
 * the first non-empty trimmed line, strip a leading `#`-style
 * markdown heading prefix, and cap at 80 characters so the UI badge
 * stays compact. Empty body → empty derived title.
 */
export function deriveTitleFromSpecBody(specBody: string): string {
  const firstLine = specBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "";
  const stripped = firstLine.replace(/^#+\s+/, "");
  if (stripped.length > 80) {
    // Single ellipsis char keeps the byte budget predictable; we trim
    // to 79 chars + ellipsis to land exactly on the 80-char cap.
    return `${stripped.slice(0, 79)}…`;
  }
  return stripped;
}

export interface NewSpecProps {
  /**
   * Test-only seam: pre-seed form state. Production callers should
   * leave this unset so the route starts from {@link EMPTY_NEW_SPEC_FORM}.
   */
  readonly initialState?: NewSpecFormState;
  /**
   * Fixture-state seam for M2 route review. M3 replaces this with live
   * repository/spec discovery state.
   */
  readonly fixtureState?: NewSpecFixtureState;
}

export function NewSpec(props: NewSpecProps): React.JSX.Element {
  const [form, setForm] = useState<NewSpecFormState>(
    () => props.initialState ?? EMPTY_NEW_SPEC_FORM,
  );
  const fixtureState = props.fixtureState ?? "happy";

  const validation = validateNewSpecForm(form);
  const derivedTitle = deriveTitleFromSpecBody(form.specBody);
  const effectiveTitle =
    form.titleOverride.trim() !== "" ? form.titleOverride.trim() : derivedTitle;

  const updateField = <K extends keyof NewSpecFormState>(
    key: K,
    value: NewSpecFormState[K],
  ): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const openModal = (): void => setForm(openNewSpecConfirmation);
  const closeModal = (): void => setForm(closeNewSpecConfirmation);

  return (
    <section
      className="new-spec"
      data-testid="new-spec-route"
      data-route="runs.new"
      data-fixture-state={fixtureState}
      data-modal-open={form.modalOpen ? "true" : "false"}
      aria-labelledby="new-spec-title"
    >
      <header className="new-spec__header">
        <h1 id="new-spec-title">{ROUTES["runs.new"].title}</h1>
      </header>
      <p
        className="new-spec__fixture-banner"
        data-testid="fixture-banner"
        role="status"
      >
        {FIXTURE_BANNER_LABEL} · new-spec · mock repo/spec pickers
      </p>

      {fixtureState === "loading" ? (
        <p
          className="new-spec__loading"
          data-testid="new-spec-loading"
          role="status"
        >
          Loading mocked repository roots and spec files...
        </p>
      ) : null}
      {fixtureState === "empty" ? (
        <p className="new-spec__empty" data-testid="new-spec-empty">
          No mock repository roots or spec files are available.
        </p>
      ) : null}
      {fixtureState === "error" ? (
        <p
          className="new-spec__error"
          data-testid="new-spec-error"
          role="alert"
        >
          Unable to load mocked repository roots and spec files.
        </p>
      ) : null}

      {fixtureState === "happy" ? (
        <>
      <fieldset className="new-spec__field">
        <legend>Repository root</legend>
        <label htmlFor="new-spec-repo-root">
          Pick a repo root (mock — M3 wires a real picker):
        </label>
        <select
          id="new-spec-repo-root"
          data-testid="new-spec-repo-root"
          value={form.repoRoot}
          onChange={(e) => updateField("repoRoot", e.target.value)}
        >
          <option value="">(none selected)</option>
          {REPO_ROOT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="new-spec__field">
        <legend>Spec file</legend>
        <label htmlFor="new-spec-spec-file">
          Pick a spec file (mock — M3 wires a real picker):
        </label>
        <select
          id="new-spec-spec-file"
          data-testid="new-spec-spec-file"
          value={form.specFile}
          onChange={(e) => updateField("specFile", e.target.value)}
        >
          <option value="">(none selected)</option>
          {SPEC_FILE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </fieldset>

      <fieldset className="new-spec__field">
        <legend>Spec body</legend>
        <label htmlFor="new-spec-body">Paste or edit the spec body:</label>
        <textarea
          id="new-spec-body"
          data-testid="new-spec-body"
          rows={10}
          value={form.specBody}
          onChange={(e) => updateField("specBody", e.target.value)}
        />
      </fieldset>

      <fieldset className="new-spec__field">
        <legend>Title</legend>
        <p
          className="new-spec__derived-title"
          data-testid="new-spec-derived-title"
        >
          Derived title:{" "}
          {derivedTitle === "" ? (
            <em>(empty — type or paste a spec body)</em>
          ) : (
            derivedTitle
          )}
        </p>
        <label htmlFor="new-spec-title-override">Override (optional):</label>
        <input
          id="new-spec-title-override"
          data-testid="new-spec-title-override"
          type="text"
          value={form.titleOverride}
          onChange={(e) => updateField("titleOverride", e.target.value)}
        />
        <p
          className="new-spec__effective-title"
          data-testid="new-spec-effective-title"
        >
          Effective title:{" "}
          {effectiveTitle === "" ? (
            <em>(empty)</em>
          ) : (
            effectiveTitle
          )}
        </p>
      </fieldset>

      {validation.reason !== null ? (
        <p
          className="new-spec__validation"
          data-testid="new-spec-validation"
          role="status"
        >
          {validation.reason}
        </p>
      ) : null}

      <button
        type="button"
        className="new-spec__submit"
        data-testid="new-spec-submit"
        disabled={validation.disabled}
        aria-disabled={validation.disabled}
        onClick={openModal}
      >
        Submit
      </button>

      <ConfirmationModal
        isOpen={form.modalOpen}
        action="Create plan from spec"
        confirmLabel="Acknowledge"
        cancelLabel="Dismiss"
        onConfirm={closeModal}
        onCancel={closeModal}
      >
        <p data-testid="new-spec-modal-deferral-copy">
          {M3_M4_DEFERRAL_COPY}
        </p>
        <dl className="new-spec__modal-summary" data-testid="new-spec-modal-summary">
          <dt>Repo root</dt>
          <dd>{form.repoRoot}</dd>
          <dt>Spec file</dt>
          <dd>{form.specFile === "" ? "(inline)" : form.specFile}</dd>
          <dt>Title</dt>
          <dd>{effectiveTitle === "" ? "(empty)" : effectiveTitle}</dd>
        </dl>
      </ConfirmationModal>
        </>
      ) : null}
    </section>
  );
}
