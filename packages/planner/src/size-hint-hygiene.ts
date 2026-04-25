import type { Plan, ReviewFinding, Task, TaskSizeHint } from "@pm-go/contracts";

const DESTRUCTIVE_OR_MIGRATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bmigrat\w+\b/i,
  /\bschema\b/i,
  /\bdrop\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bdestructive\b/i,
  /\brm\s+-rf\b/i,
];

export function effectiveSizeHint(task: Task): TaskSizeHint {
  return task.sizeHint ?? "medium";
}

function acceptanceMentionsDestructiveWork(task: Task): boolean {
  for (const ac of task.acceptanceCriteria) {
    const text = `${ac.description}\n${ac.verificationCommands.join("\n")}`;
    for (const pattern of DESTRUCTIVE_OR_MIGRATION_PATTERNS) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

/**
 * Plan-audit check (v0.8.2 Task 1.1):
 *
 * Reject inconsistent `sizeHint="small"` combos. The fast path is only
 * meaningful when the task is genuinely low-risk and reviewer-skippable;
 * any of the following combos is a planning bug:
 *
 *   - `small` + `riskLevel="high"`
 *   - `small` + `requiresHumanApproval=true`
 *   - `small` + acceptance criteria mentioning migrations / destructive work
 *
 * Findings are emitted at high severity since the host will refuse to
 * apply the fast path when these combos exist anyway — better to fail
 * loud at audit time than to silently demote to `medium` later.
 */
export function auditPlanSizeHints(plan: Plan): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const task of plan.tasks) {
    if (effectiveSizeHint(task) !== "small") continue;

    if (task.riskLevel === "high") {
      findings.push({
        id: "plan_audit.tasks.sizeHint.smallHighRisk",
        severity: "high",
        title: `Task "${task.slug}" combines sizeHint="small" with riskLevel="high"`,
        summary:
          `Task "${task.slug}" (${task.id}) declares sizeHint="small" but ` +
          `riskLevel="high". Small tasks bypass the formal reviewer; a ` +
          `high-risk task is exactly the kind of work that needs review.`,
        filePath: `plan.tasks[${task.slug}]`,
        confidence: 1,
        suggestedFixDirection:
          "Either downgrade riskLevel to low/medium honestly, or change sizeHint to medium so review runs.",
      });
    }

    if (task.requiresHumanApproval) {
      findings.push({
        id: "plan_audit.tasks.sizeHint.smallHumanApproval",
        severity: "high",
        title: `Task "${task.slug}" combines sizeHint="small" with requiresHumanApproval=true`,
        summary:
          `Task "${task.slug}" (${task.id}) declares sizeHint="small" but ` +
          `also requiresHumanApproval=true. Small tasks fast-path through ` +
          `to ready_to_merge; a human-approval gate contradicts that intent.`,
        filePath: `plan.tasks[${task.slug}]`,
        confidence: 1,
        suggestedFixDirection:
          "Drop sizeHint to medium, or remove requiresHumanApproval if the task truly is small.",
      });
    }

    if (acceptanceMentionsDestructiveWork(task)) {
      findings.push({
        id: "plan_audit.tasks.sizeHint.smallDestructive",
        severity: "high",
        title: `Task "${task.slug}" combines sizeHint="small" with destructive/migration acceptance criteria`,
        summary:
          `Task "${task.slug}" (${task.id}) declares sizeHint="small" but ` +
          `its acceptance criteria reference migrations, schema changes, ` +
          `or destructive operations. Those almost always need review.`,
        filePath: `plan.tasks[${task.slug}].acceptanceCriteria`,
        confidence: 0.9,
        suggestedFixDirection:
          "Promote sizeHint to medium so review runs, or rephrase the acceptance criteria if the implication is unintended.",
      });
    }
  }
  return findings;
}
