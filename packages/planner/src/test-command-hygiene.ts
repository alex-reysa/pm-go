import type { Plan, ReviewFinding, Task } from "@pm-go/contracts";

export interface TestCommandIssue {
  taskId: string;
  taskSlug: string;
  index: number;
  original: string;
  message: string;
  suggestion?: string;
}

export interface NormalizeOutcome {
  command: string;
  rewritten: boolean;
  rejected: boolean;
  message?: string;
}

const FORBIDDEN_TEST_FILTER =
  /^\s*pnpm(\s+--?[a-zA-Z0-9_-]+(?:=\S+)?)*\s+test(\s+--?[a-zA-Z0-9_-]+(?:=\S+)?)*\s+--filter(\s+|=)/;

const PNPM_TEST_FILTER_REWRITE =
  /^\s*pnpm\s+test\s+--filter(?:\s+|=)([^\s]+)\s*(.*)$/;

/**
 * Normalize a single testCommand string.
 *
 * Recognises the known-bad shape `pnpm test --filter <pkg>` and rewrites it to
 * `pnpm --filter <pkg> test`. Returns `rejected: true` for `pnpm` invocations
 * that mix `test` with `--filter` in any other order we can't safely rewrite.
 */
export function normalizeTestCommand(input: string): NormalizeOutcome {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { command: input, rewritten: false, rejected: false };
  }

  const rewrite = trimmed.match(PNPM_TEST_FILTER_REWRITE);
  if (rewrite) {
    const pkg = rewrite[1]!;
    const tail = rewrite[2]!.trim();
    const command = tail.length > 0
      ? `pnpm --filter ${pkg} test ${tail}`
      : `pnpm --filter ${pkg} test`;
    return {
      command,
      rewritten: true,
      rejected: false,
      message:
        "Rewrote `pnpm test --filter <pkg>` to `pnpm --filter <pkg> test`. " +
        "Use `pnpm --filter <pkg> test`; do not append `--filter` after `pnpm test`.",
    };
  }

  if (FORBIDDEN_TEST_FILTER.test(trimmed)) {
    return {
      command: input,
      rewritten: false,
      rejected: true,
      message:
        "Use `pnpm --filter <pkg> test`; do not append `--filter` after `pnpm test`.",
    };
  }

  return { command: input, rewritten: false, rejected: false };
}

/**
 * Validate the testCommands on a single Task. Returns one issue per
 * non-conforming command. An empty array means the task is clean.
 */
export function validateTaskTestCommands(task: Task): TestCommandIssue[] {
  const issues: TestCommandIssue[] = [];
  const commands = task.testCommands ?? [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const outcome = normalizeTestCommand(cmd);
    if (!outcome.rejected && !outcome.rewritten) continue;
    const issue: TestCommandIssue = {
      taskId: task.id,
      taskSlug: task.slug,
      index: i,
      original: cmd,
      message: outcome.message ?? "Invalid testCommand shape.",
    };
    if (outcome.rewritten) issue.suggestion = outcome.command;
    issues.push(issue);
  }
  return issues;
}

/**
 * Audit every task in a Plan for testCommand hygiene. Emits one
 * `plan_audit.tasks.testCommands.hygiene` finding per offending command.
 */
export function auditPlanTestCommands(plan: Plan): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const task of plan.tasks) {
    for (const issue of validateTaskTestCommands(task)) {
      findings.push({
        id: "plan_audit.tasks.testCommands.hygiene",
        severity: "high",
        title: `Task "${task.slug}" testCommand[${issue.index}] uses forbidden shape`,
        summary:
          `Command \`${issue.original}\` on task "${task.slug}" (${task.id}) ` +
          `is not workspace-safe. ${issue.message}` +
          (issue.suggestion ? ` Suggested rewrite: \`${issue.suggestion}\`.` : ""),
        filePath: `plan.tasks[${task.slug}].testCommands[${issue.index}]`,
        confidence: 1,
        suggestedFixDirection:
          issue.suggestion
            ? `Replace with: ${issue.suggestion}`
            : "Use `pnpm --filter <pkg> test` instead of `pnpm test --filter <pkg>`.",
      });
    }
  }
  return findings;
}

/**
 * Mutating helper: rewrite known-bad testCommands in place where it is safe to
 * do so. Leaves rejected (un-rewritable) commands untouched and returns the
 * issue list so callers can fail loudly. Useful as the "before persistence"
 * normalization pass referenced in v0.8.2 Task 0.1.
 */
export function applyTestCommandRewrites(plan: Plan): {
  rewrites: TestCommandIssue[];
  rejections: TestCommandIssue[];
} {
  const rewrites: TestCommandIssue[] = [];
  const rejections: TestCommandIssue[] = [];
  for (const task of plan.tasks) {
    const next: string[] = [];
    const commands = task.testCommands ?? [];
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const outcome = normalizeTestCommand(cmd);
      if (outcome.rewritten) {
        rewrites.push({
          taskId: task.id,
          taskSlug: task.slug,
          index: i,
          original: cmd,
          message: outcome.message ?? "rewritten",
          suggestion: outcome.command,
        });
        next.push(outcome.command);
      } else if (outcome.rejected) {
        rejections.push({
          taskId: task.id,
          taskSlug: task.slug,
          index: i,
          original: cmd,
          message: outcome.message ?? "rejected",
        });
        next.push(cmd);
      } else {
        next.push(cmd);
      }
    }
    task.testCommands = next;
  }
  return { rewrites, rejections };
}
