import type {
  CompletionAuditReport,
  MergeRun,
  Phase,
  PhaseAuditReport,
  Plan,
  ReviewFinding,
} from "@pm-go/contracts";

/**
 * Evidence required to render a PR summary. Assembled by the activity
 * layer from the durable audit/merge state; kept narrow so the render
 * function stays pure + deterministic.
 */
export interface PrSummaryEvidence {
  phaseAudits: PhaseAuditReport[];
  mergeRuns: MergeRun[];
  /** Optional artifact id for the evidence bundle, cited in the traceability section when available. */
  evidenceBundleArtifactId?: string;
}

/**
 * Render a PR-ready markdown summary from a passing completion audit.
 *
 * Guarantees:
 * - Pure: no I/O, no timestamps injected. Only input-provided timestamps
 *   (`completionAudit.createdAt`, per-phase-audit `createdAt`) appear.
 * - Deterministic: phases iterate in `plan.phases` index order; phase
 *   audits/merge runs are matched to phases by id; findings iterate in
 *   input order.
 * - Byte-identical across runs for identical inputs (test enforces).
 * - Optional sections omitted when empty (open findings, unresolved
 *   policy decisions, evidence-bundle id).
 */
export function renderPrSummaryMarkdown(
  plan: Plan,
  completionAudit: CompletionAuditReport,
  evidence: PrSummaryEvidence,
): string {
  const lines: string[] = [];

  lines.push(`# Release: ${plan.title}`);
  lines.push("");
  lines.push(`**Plan ID:** ${plan.id}`);
  lines.push(`**Completion audit:** ${completionAudit.id}`);
  lines.push(`**Audit outcome:** ${completionAudit.outcome}`);
  lines.push(`**Audited head:** ${completionAudit.auditedHeadSha}`);
  lines.push(`**Audit timestamp:** ${completionAudit.createdAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(plan.summary);
  lines.push("");

  // Per-phase table. Phases sort by index; audits + merge runs are
  // looked up by phaseId so the rendering is stable even if the
  // evidence arrays arrive in arbitrary order.
  const phasesByIndex = [...plan.phases].sort((a, b) => a.index - b.index);
  const auditsByPhaseId = new Map<string, PhaseAuditReport>();
  for (const a of evidence.phaseAudits) auditsByPhaseId.set(a.phaseId, a);
  const mergeByPhaseId = new Map<string, MergeRun>();
  for (const m of evidence.mergeRuns) {
    // Prefer the merge run cited by the phase audit; fall back to any
    // run for the phase.
    const audit = auditsByPhaseId.get(m.phaseId);
    if (audit && audit.mergeRunId === m.id) {
      mergeByPhaseId.set(m.phaseId, m);
    } else if (!mergeByPhaseId.has(m.phaseId)) {
      mergeByPhaseId.set(m.phaseId, m);
    }
  }

  lines.push("## Phases");
  lines.push("");
  for (const phase of phasesByIndex) {
    lines.push(`### Phase ${phase.index}: ${phase.title}`);
    lines.push(`- **Status:** ${phase.status}`);
    const audit = auditsByPhaseId.get(phase.id);
    if (audit) {
      lines.push(`- **Audit outcome:** ${audit.outcome}`);
      lines.push(`- **Audited head:** ${audit.mergedHeadSha}`);
      lines.push(`- **Audit summary:** ${audit.summary}`);
    } else {
      lines.push("- **Audit outcome:** _not audited_");
    }
    const merge = mergeByPhaseId.get(phase.id);
    if (merge) {
      lines.push(
        `- **Merge range:** \`${merge.baseSha}..${merge.integrationHeadSha ?? "(in flight)"}\``,
      );
      lines.push(`- **Integration branch:** ${merge.integrationBranch}`);
      if (merge.mergedTaskIds.length > 0) {
        const slugs = renderTaskSlugs(plan, merge.mergedTaskIds);
        lines.push(`- **Merged tasks:** ${slugs}`);
      }
    }
    lines.push("");
  }

  // Cumulative acceptance criteria from the completion audit summary.
  lines.push("## Acceptance criteria");
  lines.push("");
  if (completionAudit.summary.acceptanceCriteriaPassed.length > 0) {
    lines.push("**Passed:**");
    for (const ac of completionAudit.summary.acceptanceCriteriaPassed) {
      lines.push(`- \`${ac}\``);
    }
    lines.push("");
  } else {
    lines.push("_No acceptance criteria recorded as passed._");
    lines.push("");
  }
  if (completionAudit.summary.acceptanceCriteriaMissing.length > 0) {
    lines.push("**Missing:**");
    for (const ac of completionAudit.summary.acceptanceCriteriaMissing) {
      lines.push(`- \`${ac}\``);
    }
    lines.push("");
  }

  // Open findings (only when non-empty).
  if (completionAudit.findings.length > 0) {
    lines.push("## Open findings");
    lines.push("");
    // Group by severity for readability; iterate severities in a fixed
    // order so the render stays deterministic.
    const bySeverity = groupFindingsBySeverity(completionAudit.findings);
    for (const severity of ["high", "medium", "low"] as const) {
      const group = bySeverity[severity];
      if (group.length === 0) continue;
      lines.push(`### ${severity.toUpperCase()}`);
      for (const f of group) {
        lines.push(`- **${f.title}** (${f.filePath}${renderLineRange(f)})`);
        lines.push(`  - ${f.summary}`);
        lines.push(`  - Suggested fix: ${f.suggestedFixDirection}`);
      }
      lines.push("");
    }
  }

  // Unresolved policy decisions, if any.
  if (completionAudit.summary.unresolvedPolicyDecisionIds.length > 0) {
    lines.push("## Unresolved policy decisions");
    lines.push("");
    for (const id of completionAudit.summary.unresolvedPolicyDecisionIds) {
      lines.push(`- \`${id}\``);
    }
    lines.push("");
  }

  // Traceability — cite phase audits, merge runs, evidence bundle if set.
  lines.push("## Traceability");
  lines.push("");
  lines.push("**Phase audit reports:**");
  for (const phase of phasesByIndex) {
    const audit = auditsByPhaseId.get(phase.id);
    if (audit) {
      lines.push(`- Phase ${phase.index} (\`${phase.id}\`): \`${audit.id}\``);
    }
  }
  lines.push("");
  lines.push("**Merge runs:**");
  for (const phase of phasesByIndex) {
    const merge = mergeByPhaseId.get(phase.id);
    if (merge) {
      lines.push(`- Phase ${phase.index} (\`${phase.id}\`): \`${merge.id}\``);
    }
  }
  lines.push("");
  if (evidence.evidenceBundleArtifactId !== undefined) {
    lines.push(`**Evidence bundle artifact:** \`${evidence.evidenceBundleArtifactId}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "_Generated by the pm-go release pipeline. Source of truth is the durable audit state._",
  );

  return `${lines.join("\n")}\n`;
}

function renderTaskSlugs(plan: Plan, taskIds: readonly string[]): string {
  const bySlug: string[] = [];
  for (const id of taskIds) {
    const t = plan.tasks.find((x) => x.id === id);
    bySlug.push(t ? `\`${t.slug}\`` : `\`<${id.slice(0, 8)}>\``);
  }
  return bySlug.join(", ");
}

function groupFindingsBySeverity(
  findings: readonly ReviewFinding[],
): { high: ReviewFinding[]; medium: ReviewFinding[]; low: ReviewFinding[] } {
  const out = { high: [] as ReviewFinding[], medium: [] as ReviewFinding[], low: [] as ReviewFinding[] };
  for (const f of findings) {
    out[f.severity].push(f);
  }
  return out;
}

function renderLineRange(f: ReviewFinding): string {
  if (typeof f.startLine !== "number") return "";
  if (typeof f.endLine === "number" && f.endLine !== f.startLine) {
    return `:${f.startLine}-${f.endLine}`;
  }
  return `:${f.startLine}`;
}
