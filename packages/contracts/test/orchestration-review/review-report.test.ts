import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { ReviewReport } from "../../src/review.js";
import {
  ReviewReportSchema,
  validateReviewReport
} from "../../src/validators/orchestration-review/review-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/review-report.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _ReviewReportSubtypeCheck =
  Static<typeof ReviewReportSchema> extends ReviewReport ? true : never;
const _reportOk: _ReviewReportSubtypeCheck = true;
void _reportOk;

describe("validateReviewReport", () => {
  it("accepts the realistic changes_requested fixture", () => {
    expect(validateReviewReport(fixture)).toBe(true);
  });

  it("rejects a report whose outcome is not a ReviewOutcome literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      outcome: "approved"
    };
    expect(validateReviewReport(mutated)).toBe(false);
  });

  it("rejects a report missing the required findings field", () => {
    const { findings: _findings, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _findings;
    expect(validateReviewReport(rest)).toBe(false);
  });
});
