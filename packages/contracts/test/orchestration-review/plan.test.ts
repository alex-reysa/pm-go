import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { Plan } from "../../src/plan.js";
import {
  PlanSchema,
  validatePlan
} from "../../src/validators/orchestration-review/plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/plan.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

// Compile-time assignability: Static<typeof PlanSchema> must be a Plan.
type _PlanSubtypeCheck = Static<typeof PlanSchema> extends Plan ? true : never;
const _planOk: _PlanSubtypeCheck = true;
void _planOk;

describe("validatePlan", () => {
  it("accepts the realistic plan fixture", () => {
    expect(validatePlan(fixture)).toBe(true);
  });

  it("rejects a plan whose status is not a PlanStatus literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      status: "not-a-real-status"
    };
    expect(validatePlan(mutated)).toBe(false);
  });

  it("rejects a plan missing the required phases field", () => {
    const { phases: _phases, ...rest } = fixture as Record<string, unknown>;
    void _phases;
    expect(validatePlan(rest)).toBe(false);
  });

  it("rejects a plan with an unexpected top-level field", () => {
    const extra = {
      ...(fixture as Record<string, unknown>),
      unexpected: "field"
    };
    expect(validatePlan(extra)).toBe(false);
  });
});
