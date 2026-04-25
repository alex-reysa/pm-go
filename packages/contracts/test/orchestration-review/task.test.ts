import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { Task } from "../../src/plan.js";
import {
  TaskSchema,
  validateTask
} from "../../src/validators/orchestration-review/task.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/task.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _TaskSubtypeCheck = Static<typeof TaskSchema> extends Task ? true : never;
const _taskOk: _TaskSubtypeCheck = true;
void _taskOk;

describe("validateTask", () => {
  it("accepts the realistic task fixture", () => {
    expect(validateTask(fixture)).toBe(true);
  });

  it("rejects a task whose kind is not a TaskKind literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      kind: "ad-hoc"
    };
    expect(validateTask(mutated)).toBe(false);
  });

  it("rejects a task whose reviewerPolicy.reviewerWriteAccess is true", () => {
    const base = fixture as Record<string, unknown>;
    const reviewerPolicy = {
      ...(base.reviewerPolicy as Record<string, unknown>),
      reviewerWriteAccess: true
    };
    const mutated = { ...base, reviewerPolicy };
    expect(validateTask(mutated)).toBe(false);
  });

  it("rejects a task missing the required acceptanceCriteria field", () => {
    const { acceptanceCriteria: _ac, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _ac;
    expect(validateTask(rest)).toBe(false);
  });

  it("rejects a task with an unexpected top-level field", () => {
    const extra = {
      ...(fixture as Record<string, unknown>),
      unexpected: "field"
    };
    expect(validateTask(extra)).toBe(false);
  });

  it("accepts a task carrying sizeHint='small'", () => {
    const withHint = {
      ...(fixture as Record<string, unknown>),
      sizeHint: "small"
    };
    expect(validateTask(withHint)).toBe(true);
  });

  it("accepts a task without sizeHint (optional field)", () => {
    expect(validateTask(fixture)).toBe(true);
  });

  it("rejects a task whose sizeHint is not a TaskSizeHint literal", () => {
    const bad = {
      ...(fixture as Record<string, unknown>),
      sizeHint: "tiny"
    };
    expect(validateTask(bad)).toBe(false);
  });
});
