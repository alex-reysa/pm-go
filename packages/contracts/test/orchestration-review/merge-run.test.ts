import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { MergeRun } from "../../src/execution.js";
import {
  MergeRunSchema,
  validateMergeRun,
} from "../../src/validators/orchestration-review/merge-run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/merge-run.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _MergeRunSubtypeCheck = Static<typeof MergeRunSchema> extends MergeRun
  ? true
  : never;
const _runOk: _MergeRunSubtypeCheck = true;
void _runOk;

describe("validateMergeRun", () => {
  it("accepts the realistic completed-run fixture", () => {
    expect(validateMergeRun(fixture)).toBe(true);
  });

  it("accepts an in-flight run with no completedAt or integrationHeadSha", () => {
    const inFlight = {
      ...(fixture as Record<string, unknown>),
    };
    delete (inFlight as Record<string, unknown>)["completedAt"];
    delete (inFlight as Record<string, unknown>)["integrationHeadSha"];
    expect(validateMergeRun(inFlight)).toBe(true);
  });

  it("rejects a run whose mergedTaskIds contains a non-UUID entry", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      mergedTaskIds: ["not-a-uuid"],
    };
    expect(validateMergeRun(mutated)).toBe(false);
  });

  it("rejects a run whose integrationHeadSha is not a 40-char lowercase hex", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      integrationHeadSha: "not-a-sha",
    };
    expect(validateMergeRun(mutated)).toBe(false);
  });

  it("rejects a run missing the required phaseId field", () => {
    const { phaseId: _phaseId, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _phaseId;
    expect(validateMergeRun(rest)).toBe(false);
  });

  it("rejects a run with an unexpected top-level field", () => {
    const extra = {
      ...(fixture as Record<string, unknown>),
      unexpected: "field",
    };
    expect(validateMergeRun(extra)).toBe(false);
  });
});
