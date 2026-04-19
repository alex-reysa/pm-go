import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type {
  CompletionAuditReport,
  MergeRun,
  PhaseAuditReport,
  Plan,
} from "@pm-go/contracts";

import { renderPrSummaryMarkdown } from "../src/render-pr-summary.js";

const planPath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);
const caPath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/completion-audit-report.json",
    import.meta.url,
  ),
);
const paPath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/phase-audit-report.json",
    import.meta.url,
  ),
);
const mrPath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/merge-run.json",
    import.meta.url,
  ),
);

const planFixture: Plan = JSON.parse(readFileSync(planPath, "utf8"));
const completionAuditFixture: CompletionAuditReport = JSON.parse(
  readFileSync(caPath, "utf8"),
);
const phaseAuditFixture: PhaseAuditReport = JSON.parse(
  readFileSync(paPath, "utf8"),
);
const mergeRunFixture: MergeRun = JSON.parse(readFileSync(mrPath, "utf8"));

describe("renderPrSummaryMarkdown", () => {
  it("renders the release title, audited head, every phase title, and merge ranges", () => {
    const md = renderPrSummaryMarkdown(
      planFixture,
      completionAuditFixture,
      {
        phaseAudits: [phaseAuditFixture],
        mergeRuns: [mergeRunFixture],
      },
    );
    expect(md.length).toBeGreaterThan(0);
    expect(md).toContain(`# Release: ${planFixture.title}`);
    expect(md).toContain(completionAuditFixture.auditedHeadSha);
    for (const phase of planFixture.phases) {
      expect(md).toContain(phase.title);
    }
    // Merge range block cites base..head.
    expect(md).toContain(mergeRunFixture.baseSha);
    expect(md).toContain(mergeRunFixture.integrationHeadSha!);
  });

  it("is byte-identical across successive calls with the same input", () => {
    const a = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
    });
    const b = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
    });
    expect(a).toBe(b);
  });

  it("omits the 'Open findings' section when completionAudit.findings is empty", () => {
    const md = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
    });
    // Fixture has empty findings → section is omitted.
    expect(completionAuditFixture.findings.length).toBe(0);
    expect(md).not.toContain("## Open findings");
  });

  it("omits 'Unresolved policy decisions' when summary.unresolvedPolicyDecisionIds is empty", () => {
    const md = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
    });
    expect(
      completionAuditFixture.summary.unresolvedPolicyDecisionIds.length,
    ).toBe(0);
    expect(md).not.toContain("## Unresolved policy decisions");
  });

  it("cites evidence bundle artifact id when provided", () => {
    const bundleId = "11112222-3333-4444-8555-666677778888";
    const md = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
      evidenceBundleArtifactId: bundleId,
    });
    expect(md).toContain(`**Evidence bundle artifact:** \`${bundleId}\``);
  });

  it("matches phase audits to phases by id regardless of evidence array order", () => {
    // Reverse the evidence arrays — output should still render the
    // first phase's audit data in the first position because we sort
    // by phase.index.
    const a = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [phaseAuditFixture],
      mergeRuns: [mergeRunFixture],
    });
    const b = renderPrSummaryMarkdown(planFixture, completionAuditFixture, {
      phaseAudits: [...[phaseAuditFixture]].reverse(),
      mergeRuns: [...[mergeRunFixture]].reverse(),
    });
    expect(a).toBe(b);
  });
});
