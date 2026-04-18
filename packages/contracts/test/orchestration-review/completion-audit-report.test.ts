import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { CompletionAuditReport } from "../../src/review.js";
import {
  CompletionAuditReportSchema,
  validateCompletionAuditReport
} from "../../src/validators/orchestration-review/completion-audit-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/completion-audit-report.json"
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _AuditSubtypeCheck =
  Static<typeof CompletionAuditReportSchema> extends CompletionAuditReport
    ? true
    : never;
const _auditOk: _AuditSubtypeCheck = true;
void _auditOk;

describe("validateCompletionAuditReport", () => {
  it("accepts the realistic pass-outcome fixture", () => {
    expect(validateCompletionAuditReport(fixture)).toBe(true);
  });

  it("rejects an audit whose auditedHeadSha is not 40 hex chars", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      auditedHeadSha: "not-a-real-sha"
    };
    expect(validateCompletionAuditReport(mutated)).toBe(false);
  });

  it("rejects an audit missing the required mergeRunId", () => {
    const { mergeRunId: _mergeRunId, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _mergeRunId;
    expect(validateCompletionAuditReport(rest)).toBe(false);
  });

  it("rejects an audit whose outcome is not a CompletionAuditOutcome literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      outcome: "needs-more-info"
    };
    expect(validateCompletionAuditReport(mutated)).toBe(false);
  });

  it("rejects an audit with an unexpected top-level field", () => {
    const extra = {
      ...(fixture as Record<string, unknown>),
      unexpected: "field"
    };
    expect(validateCompletionAuditReport(extra)).toBe(false);
  });
});
