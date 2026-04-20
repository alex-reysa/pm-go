import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { WorkflowEvent } from "../../src/events.js";
import {
  WorkflowEventSchema,
  validateWorkflowEvent,
} from "../../src/validators/events/workflow-event.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/events/workflow-event.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _WorkflowEventSubtypeCheck = Static<
  typeof WorkflowEventSchema
> extends WorkflowEvent
  ? true
  : never;
const _ok: _WorkflowEventSubtypeCheck = true;
void _ok;

describe("validateWorkflowEvent", () => {
  it("accepts the phase_status_changed fixture", () => {
    expect(validateWorkflowEvent(fixture)).toBe(true);
  });

  it("rejects events with an unknown kind", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      kind: "not_a_known_kind",
    };
    expect(validateWorkflowEvent(mutated)).toBe(false);
  });

  it("rejects phase_status_changed events missing phaseId (subject is required)", () => {
    const { phaseId: _phaseId, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _phaseId;
    expect(validateWorkflowEvent(rest)).toBe(false);
  });

  it("rejects payloads whose status isn't a valid PhaseStatus literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      payload: { previousStatus: "integrating", nextStatus: "approved" },
    };
    expect(validateWorkflowEvent(mutated)).toBe(false);
  });

  it("rejects events with an unexpected top-level field (additionalProperties: false)", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      extra: "nope",
    };
    expect(validateWorkflowEvent(mutated)).toBe(false);
  });

  it("rejects events whose createdAt is not an ISO-8601 date-time", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      createdAt: "yesterday",
    };
    expect(validateWorkflowEvent(mutated)).toBe(false);
  });
});
