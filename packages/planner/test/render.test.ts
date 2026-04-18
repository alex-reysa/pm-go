import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan } from "@pm-go/contracts";

import { renderPlanMarkdown } from "../src/render.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const planFixture: Plan = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("renderPlanMarkdown", () => {
  it("renders the plan title, every phase title, and every task slug", () => {
    const md = renderPlanMarkdown(planFixture);
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain(`# ${planFixture.title}`);
    for (const phase of planFixture.phases) {
      expect(md).toContain(phase.title);
    }
    for (const task of planFixture.tasks) {
      expect(md).toContain(task.slug);
    }
  });

  it("is byte-identical across successive calls with the same input", () => {
    const a = renderPlanMarkdown(planFixture);
    const b = renderPlanMarkdown(planFixture);
    expect(a).toBe(b);
  });

  it("omits the Risks section when plan.risks is empty", () => {
    const planNoRisks: Plan = {
      ...planFixture,
      risks: [],
    };
    const md = renderPlanMarkdown(planNoRisks);
    expect(md).not.toContain("## Risks");
  });
});
