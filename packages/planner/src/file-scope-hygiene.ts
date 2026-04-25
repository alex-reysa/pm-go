import type { Plan, ReviewFinding, Task } from "@pm-go/contracts";

const PACKAGE_CREATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnew\s+(?:workspace\s+)?package\b/i,
  /\bcreate(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\badd(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\bscaffold(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\bbootstrap(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
];

const REQUIRED_ROOT_ARTIFACTS: ReadonlyArray<string> = [
  "package.json",
  "pnpm-lock.yaml",
];

/**
 * True iff the task's title/summary suggests it is creating or modifying a
 * workspace package. Pure heuristic; the audit emits a finding (not a hard
 * reject) so a false positive can be silenced by a planner that explicitly
 * justifies why no root manifest changes are needed.
 */
export function taskSignalsPackageCreation(task: Task): boolean {
  const haystack = `${task.title}\n${task.summary}`;
  for (const pattern of PACKAGE_CREATION_PATTERNS) {
    if (pattern.test(haystack)) return true;
  }
  return false;
}

/**
 * Names the root-level artifacts missing from `task.fileScope.includes` that
 * the v0.8.2 planner contract requires for any task that creates a workspace
 * package. Returns an empty array if the task is clean.
 */
export function missingRootArtifactScopes(task: Task): string[] {
  const includes = new Set(task.fileScope.includes ?? []);
  return REQUIRED_ROOT_ARTIFACTS.filter((path) => !includes.has(path));
}

/**
 * Audit a Plan for tasks that signal new-workspace-package creation but omit
 * required root artifacts from `fileScope.includes`. Emits one finding per
 * offending task. Severity is `medium` — the v0.8.1 benign-expansion
 * predicate remains as a runtime fallback, so this is a planning-quality
 * warning rather than a hard reject.
 */
export function auditPlanFileScopeForPackageCreation(
  plan: Plan,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const task of plan.tasks) {
    if (!taskSignalsPackageCreation(task)) continue;
    const missing = missingRootArtifactScopes(task);
    if (missing.length === 0) continue;
    findings.push({
      id: "plan_audit.tasks.fileScope.packageCreation",
      severity: "medium",
      title: `Task "${task.slug}" creates a workspace package without root artifacts in fileScope`,
      summary:
        `Task "${task.slug}" (${task.id}) appears to create or modify a ` +
        `workspace package but its fileScope.includes is missing: ` +
        `${missing.map((p) => `"${p}"`).join(", ")}. Adding a package mutates ` +
        `the root manifest and lockfile; integration will fail file-scope ` +
        `validation unless these are listed.`,
      filePath: `plan.tasks[${task.slug}].fileScope.includes`,
      confidence: 0.85,
      suggestedFixDirection:
        `Add ${missing.map((p) => `\`${p}\``).join(", ")} to ` +
        `fileScope.includes, plus the new \`packages/<name>/package.json\` or ` +
        `\`apps/<name>/package.json\` for the package being created.`,
    });
  }
  return findings;
}
