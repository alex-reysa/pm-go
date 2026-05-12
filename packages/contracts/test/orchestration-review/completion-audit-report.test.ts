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

describe("EvidenceRef acceptance", () => {
  // Reusable, real-looking RFC 4122 v4 UUIDs (lowercase hex, dashes at
  // standard positions, version nibble in [1-5], variant nibble in [89ab]).
  const ARTIFACT_UUID = "11112222-3333-4444-8555-666677778888";
  const REVIEW_UUID = "22223333-4444-4555-8666-777788889999";
  const PHASE_AUDIT_UUID = "33334444-5555-4666-8777-888899990000";
  const MERGERUN_UUID = "44445555-6666-4777-8888-999900001111";
  const POLICY_UUID = "55556666-7777-4888-8999-000011112222";
  const BARE_LEGACY_UUID = "66667777-8888-4999-8aaa-111122223333";

  // 40-character lowercase hex SHAs.
  const COMMIT_SHA = "5f02c30a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e";
  const DIFF_BASE_SHA = "abcdef0123456789abcdef0123456789abcdef01";
  const DIFF_HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

  const baseFixture = fixture as Record<string, unknown>;
  const baseChecklist = (baseFixture.checklist as Array<
    Record<string, unknown>
  >);

  function withEvidenceRefs(refs: string[]): Record<string, unknown> {
    // Override only the first checklist item's evidenceArtifactIds while
    // keeping every other field (including the remaining checklist items)
    // intact so the rest of the report stays a valid CompletionAuditReport.
    const mutatedChecklist = baseChecklist.map((item, index) =>
      index === 0 ? { ...item, evidenceArtifactIds: refs } : item
    );
    return { ...baseFixture, checklist: mutatedChecklist };
  }

  describe("accept", () => {
    it("accepts a checklist item with one entry of every typed form", () => {
      const refs = [
        `artifact:${ARTIFACT_UUID}`,
        `review:${REVIEW_UUID}`,
        `phase-audit:${PHASE_AUDIT_UUID}`,
        `mergerun:${MERGERUN_UUID}`,
        `policy:${POLICY_UUID}`,
        `commit:${COMMIT_SHA}`,
        `diff:${DIFF_BASE_SHA}..${DIFF_HEAD_SHA}`
      ];
      expect(validateCompletionAuditReport(withEvidenceRefs(refs))).toBe(true);
    });

    it("accepts a checklist item with only a bare UUID (legacy regression)", () => {
      expect(
        validateCompletionAuditReport(withEvidenceRefs([BARE_LEGACY_UUID]))
      ).toBe(true);
    });

    it("accepts a mixed array of one typed ref + one bare UUID", () => {
      const refs = [`review:${REVIEW_UUID}`, BARE_LEGACY_UUID];
      expect(validateCompletionAuditReport(withEvidenceRefs(refs))).toBe(true);
    });
  });

  describe("reject", () => {
    it("rejects mergerun:notauuid (UUID body malformed)", () => {
      expect(
        validateCompletionAuditReport(withEvidenceRefs(["mergerun:notauuid"]))
      ).toBe(false);
    });

    it("rejects commit:abc (SHA too short)", () => {
      expect(
        validateCompletionAuditReport(withEvidenceRefs(["commit:abc"]))
      ).toBe(false);
    });

    it("rejects commit:<uppercase-hex> (must be lowercase)", () => {
      expect(
        validateCompletionAuditReport(
          withEvidenceRefs([
            "commit:ABCDEF0123456789ABCDEF0123456789ABCDEF01"
          ])
        )
      ).toBe(false);
    });

    it("rejects diff:<sha> without a `..<sha>` range", () => {
      expect(
        validateCompletionAuditReport(
          withEvidenceRefs([
            "diff:5f02c30a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e"
          ])
        )
      ).toBe(false);
    });

    it("rejects diff:<sha>..<short> (second SHA truncated)", () => {
      expect(
        validateCompletionAuditReport(
          withEvidenceRefs([
            "diff:5f02c30a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e..abc"
          ])
        )
      ).toBe(false);
    });

    it("rejects an unknown prefix policydecision:<uuid> (typo guard)", () => {
      expect(
        validateCompletionAuditReport(
          withEvidenceRefs([`policydecision:${POLICY_UUID}`])
        )
      ).toBe(false);
    });

    it("rejects :<uuid> (empty kind)", () => {
      expect(
        validateCompletionAuditReport(
          withEvidenceRefs([`:${POLICY_UUID}`])
        )
      ).toBe(false);
    });
  });
});
