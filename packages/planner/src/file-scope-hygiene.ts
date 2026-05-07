import type { Plan, ReviewFinding, Task } from "@pm-go/contracts";

const PACKAGE_MUTATION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnew\s+(?:workspace\s+)?package\b/i,
  /\bcreate(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\badd(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\bscaffold(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\bbootstrap(?:\s+a)?\s+(?:new\s+)?(?:workspace\s+)?package\b/i,
  /\bmodify(?:\s+the|\s+a)?\s+(?:workspace\s+)?package\b/i,
  /\bupdate(?:\s+the|\s+a)?\s+(?:workspace\s+)?package\b/i,
  /\bchange(?:\s+the|\s+a)?\s+(?:workspace\s+)?package\b/i,
  /\badjust(?:\s+the|\s+a)?\s+(?:workspace\s+)?package\b/i,
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
  for (const pattern of PACKAGE_MUTATION_PATTERNS) {
    if (pattern.test(haystack)) return true;
  }
  return false;
}

/**
 * Names the root-level artifacts missing from `task.fileScope.includes` that
 * the planner contract requires for any task that creates or modifies a
 * workspace package. Returns an empty array if the task is clean.
 */
export function missingRootArtifactScopes(task: Task): string[] {
  const includes = new Set(task.fileScope.includes ?? []);
  return REQUIRED_ROOT_ARTIFACTS.filter((path) => !includes.has(path));
}

/**
 * Local workspace manifests required when a package-create/modify task scopes
 * files below `packages/<name>/` or `apps/<name>/`.
 */
export function missingLocalManifestScopes(task: Task): string[] {
  const includes = new Set(task.fileScope.includes ?? []);
  const required = new Set<string>();

  for (const scopedPath of includes) {
    const match = /^(packages|apps)\/([^/]+)\//.exec(scopedPath);
    if (!match) continue;
    required.add(`${match[1]}/${match[2]}/package.json`);
  }

  return [...required].filter((manifestPath) => !includes.has(manifestPath));
}

/**
 * Audit a Plan for tasks that signal workspace-package creation/modification
 * but omit required artifacts from `fileScope.includes`. Emits one finding per
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
    const missing = [
      ...missingRootArtifactScopes(task),
      ...missingLocalManifestScopes(task),
    ];
    if (missing.length === 0) continue;
    findings.push({
      id: "plan_audit.tasks.fileScope.packageCreation",
      severity: "medium",
      title: `Task "${task.slug}" creates or modifies a workspace package without required artifacts in fileScope`,
      summary:
        `Task "${task.slug}" (${task.id}) appears to create or modify a ` +
        `workspace package but its fileScope.includes is missing: ` +
        `${missing.map((p) => `"${p}"`).join(", ")}. Package creation or ` +
        `modification can mutate the root manifest, lockfile, and local ` +
        `workspace manifest; integration will fail file-scope validation ` +
        `unless these are listed.`,
      filePath: `plan.tasks[${task.slug}].fileScope.includes`,
      confidence: 0.85,
      suggestedFixDirection:
        `Add ${missing.map((p) => `\`${p}\``).join(", ")} to ` +
        `fileScope.includes.`,
    });
  }
  return findings;
}
