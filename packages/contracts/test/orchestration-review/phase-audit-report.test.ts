import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import type { Static } from "@sinclair/typebox";

import type { PhaseAuditReport } from "../../src/review.js";
import {
  PhaseAuditReportSchema,
  validatePhaseAuditReport,
} from "../../src/validators/orchestration-review/phase-audit-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  __dirname,
  "../../src/fixtures/orchestration-review/phase-audit-report.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;

type _PhaseAuditReportSubtypeCheck = Static<
  typeof PhaseAuditReportSchema
> extends PhaseAuditReport
  ? true
  : never;
const _reportOk: _PhaseAuditReportSubtypeCheck = true;
void _reportOk;

describe("validatePhaseAuditReport", () => {
  it("accepts the realistic `pass` fixture", () => {
    expect(validatePhaseAuditReport(fixture)).toBe(true);
  });

  it("rejects a report whose outcome is not a PhaseAuditOutcome literal", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      outcome: "approved",
    };
    expect(validatePhaseAuditReport(mutated)).toBe(false);
  });

  it("rejects a report whose mergedHeadSha is not a 40-char lowercase hex", () => {
    const mutated = {
      ...(fixture as Record<string, unknown>),
      mergedHeadSha: "not-a-sha",
    };
    expect(validatePhaseAuditReport(mutated)).toBe(false);
  });

  it("rejects a report missing the required mergeRunId field (audit must cite the merge)", () => {
    const { mergeRunId: _mergeRunId, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _mergeRunId;
    expect(validatePhaseAuditReport(rest)).toBe(false);
  });

  it("rejects a report missing the required summary field", () => {
    const { summary: _summary, ...rest } = fixture as Record<
      string,
      unknown
    >;
    void _summary;
    expect(validatePhaseAuditReport(rest)).toBe(false);
  });

  it("rejects a report with an unexpected top-level field", () => {
    const extra = {
      ...(fixture as Record<string, unknown>),
      unexpected: "field",
    };
    expect(validatePhaseAuditReport(extra)).toBe(false);
  });

  it("accepts bare-UUID checklist evidenceArtifactIds (legacy regression)", () => {
    // Explicit regression: the existing fixture's checklist items use bare
    // UUIDs for `evidenceArtifactIds`. After the EvidenceRef widening (bug
    // #22), the legacy bare-UUID form must remain valid for both phase and
    // completion audit reports. This assertion documents that invariant
    // independently of the broader "accepts the realistic `pass` fixture"
    // test so a regression here surfaces with an unambiguous failure.
    const checklist = (fixture as { checklist: Array<{ evidenceArtifactIds: string[] }> })
      .checklist;
    const bareUuidEntries = checklist
      .flatMap((item) => item.evidenceArtifactIds)
      .filter((ref) => !ref.includes(":"));
    expect(bareUuidEntries.length).toBeGreaterThan(0);
    expect(validatePhaseAuditReport(fixture)).toBe(true);
  });
});
