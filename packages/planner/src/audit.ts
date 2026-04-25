import type {
  DependencyEdge,
  Phase,
  Plan,
  ReviewFinding,
  Task,
} from "@pm-go/contracts";

import { auditPlanFileScopeForPackageCreation } from "./file-scope-hygiene.js";
import { auditPlanSizeHints } from "./size-hint-hygiene.js";
import { auditPlanTestCommands } from "./test-command-hygiene.js";

/**
 * Deterministic audit outcome for a drafted Plan. Mirrors the semantics
 * of `PlanAuditWorkflowResult` from `@pm-go/contracts`: `approved` is
 * true iff all checks pass; `revisionRequested` is the inverse.
 */
export interface PlanAuditOutcome {
  planId: string;
  approved: boolean;
  revisionRequested: boolean;
  findings: ReviewFinding[];
}

/**
 * Runs four deterministic structural checks on a Plan:
 *
 *  1. `plan_audit.phases.index_sequence` — phases have `index` values
 *     `[0, 1, …, phases.length - 1]` (sorted ascending).
 *  2. `plan_audit.phase1.fileScope.disjoint` — within the foundation
 *     phase (index 0), every pair of tasks has pairwise-disjoint
 *     `fileScope.includes` entries (exact-string comparison).
 *  3. `plan_audit.phase1.dependencyEdges.acyclic` — the dependency
 *     graph in phase 0 is a DAG (Kahn's algorithm).
 *  4. `plan_audit.risks.highRiskApproval` — every `Risk` with
 *     `level === "high"` also has `humanApprovalRequired: true`.
 *
 * Findings are emitted in check order; ids are stable and greppable.
 */
export function auditPlan(plan: Plan): PlanAuditOutcome {
  const findings: ReviewFinding[] = [];

  findings.push(...checkPhaseIndexSequence(plan));
  findings.push(...checkPhase1FileScopeDisjoint(plan));
  findings.push(...checkPhase1DependencyEdgesAcyclic(plan));
  findings.push(...checkHighRiskApproval(plan));
  findings.push(...auditPlanTestCommands(plan));
  findings.push(...auditPlanFileScopeForPackageCreation(plan));
  findings.push(...auditPlanSizeHints(plan));

  const approved = findings.length === 0;
  return {
    planId: plan.id,
    approved,
    revisionRequested: !approved,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Check 1: phase indices
// ---------------------------------------------------------------------------

function checkPhaseIndexSequence(plan: Plan): ReviewFinding[] {
  const sorted = [...plan.phases].sort((a, b) => a.index - b.index);
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const phase = sorted[i]!;
    if (phase.index !== i) {
      findings.push({
        id: "plan_audit.phases.index_sequence",
        severity: "high",
        title: `Phase index out of sequence: expected ${i}, got ${phase.index}`,
        summary:
          `Phase "${phase.title}" (id ${phase.id}) has index ${phase.index}; ` +
          `after sorting by index, phases must form the contiguous sequence ` +
          `[0, 1, …, ${sorted.length - 1}] with no gaps or duplicates.`,
        filePath: "plan.phases",
        confidence: 1,
        suggestedFixDirection:
          "Renumber phases so indices form a strict 0..N-1 sequence, or drop duplicate/stray phase entries.",
      });
      // One finding per offending phase is enough; keep iterating so all
      // mis-indexed phases are surfaced in a single audit pass.
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 2: phase-0 file scope disjointness
// ---------------------------------------------------------------------------

function checkPhase1FileScopeDisjoint(plan: Plan): ReviewFinding[] {
  const phase0 = findFoundationPhase(plan);
  if (!phase0) return [];

  const phaseTasks = tasksForPhase(plan, phase0);
  const findings: ReviewFinding[] = [];

  for (let i = 0; i < phaseTasks.length; i++) {
    const a = phaseTasks[i]!;
    const includesA = a.fileScope.includes ?? [];
    for (let j = i + 1; j < phaseTasks.length; j++) {
      const b = phaseTasks[j]!;
      const includesB = b.fileScope.includes ?? [];
      const overlap = includesA.filter((p) => includesB.includes(p));
      if (overlap.length > 0) {
        findings.push({
          id: "plan_audit.phase1.fileScope.disjoint",
          severity: "high",
          title: `Phase 0 file scope overlap between "${a.slug}" and "${b.slug}"`,
          summary:
            `Tasks "${a.slug}" (${a.id}) and "${b.slug}" (${b.id}) share the ` +
            `following fileScope.includes entries: ${overlap
              .map((p) => `"${p}"`)
              .join(", ")}. Phase-0 tasks must have pairwise-disjoint file scopes.`,
          filePath: `plan.phases[${phase0.index}].tasks`,
          confidence: 1,
          suggestedFixDirection:
            "Split the overlapping paths so each file belongs to exactly one phase-0 task, or merge the two tasks.",
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Check 3: phase-0 dependency DAG
// ---------------------------------------------------------------------------

function checkPhase1DependencyEdgesAcyclic(plan: Plan): ReviewFinding[] {
  const phase0 = findFoundationPhase(plan);
  if (!phase0) return [];

  const phaseTasks = tasksForPhase(plan, phase0);
  const phaseTaskIds = new Set<string>(phaseTasks.map((t) => t.id));

  // Only consider edges whose endpoints both live in phase 0.
  const edges: DependencyEdge[] = phase0.dependencyEdges.filter(
    (e) => phaseTaskIds.has(e.fromTaskId) && phaseTaskIds.has(e.toTaskId),
  );

  const cycleTaskId = findCycleVertex(phaseTasks, edges);
  if (cycleTaskId === null) return [];

  const task = phaseTasks.find((t) => t.id === cycleTaskId);
  return [
    {
      id: "plan_audit.phase1.dependencyEdges.acyclic",
      severity: "high",
      title: "Phase 0 dependency graph contains a cycle",
      summary:
        task !== undefined
          ? `Task "${task.slug}" (${task.id}) participates in a dependency cycle within phase 0. Phase dependency edges must form a DAG.`
          : `Phase 0 dependency edges form a cycle involving task ${cycleTaskId}. Phase dependency edges must form a DAG.`,
      filePath: `plan.phases[${phase0.index}].dependencyEdges`,
      confidence: 1,
      suggestedFixDirection:
        "Remove or reorient the offending edge so the phase-0 dependency graph is acyclic.",
    },
  ];
}

/**
 * Kahn's algorithm. Returns `null` if the graph is a DAG; otherwise
 * returns the id of one of the vertices that still had non-zero
 * in-degree when the queue drained — i.e. a vertex participating in
 * (or downstream of) a cycle.
 */
function findCycleVertex(
  tasks: readonly Task[],
  edges: readonly DependencyEdge[],
): string | null {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adjacency.set(t.id, []);
  }
  for (const edge of edges) {
    // Guard against malformed edges pointing outside the phase; skip them.
    if (!inDegree.has(edge.fromTaskId) || !inDegree.has(edge.toTaskId)) {
      continue;
    }
    adjacency.get(edge.fromTaskId)!.push(edge.toTaskId);
    inDegree.set(edge.toTaskId, (inDegree.get(edge.toTaskId) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const next of adjacency.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  if (processed === tasks.length) return null;
  // Find any vertex whose in-degree never hit zero — it's in/downstream of a cycle.
  for (const [id, deg] of inDegree) {
    if (deg > 0) return id;
  }
  // Should be unreachable if processed < tasks.length, but keep safe.
  return tasks[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Check 4: high-risk approval gating
// ---------------------------------------------------------------------------

function checkHighRiskApproval(plan: Plan): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const risk of plan.risks) {
    if (risk.level === "high" && !risk.humanApprovalRequired) {
      findings.push({
        id: "plan_audit.risks.highRiskApproval",
        severity: "medium",
        title: `High-risk item missing human-approval gate: "${risk.title}"`,
        summary:
          `Risk ${risk.id} ("${risk.title}") is level "high" but ` +
          `humanApprovalRequired is false. High-risk items must require ` +
          `explicit human approval before execution.`,
        filePath: "plan.risks",
        confidence: 1,
        suggestedFixDirection:
          "Either set humanApprovalRequired: true on this risk, or downgrade the severity to medium/low if it is no longer high risk.",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function findFoundationPhase(plan: Plan): Phase | undefined {
  return plan.phases.find((p) => p.index === 0);
}

function tasksForPhase(plan: Plan, phase: Phase): Task[] {
  return plan.tasks.filter((t) => t.phaseId === phase.id);
}
