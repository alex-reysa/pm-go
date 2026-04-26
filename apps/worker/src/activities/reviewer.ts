import type {
  AgentRun,
  ReviewFinding,
  ReviewReport,
  ReviewStrictness,
  Task,
  UUID,
} from "@pm-go/contracts";
import type { ReviewerRunner } from "@pm-go/executor-claude";
import { runReviewer as runReviewerPkg } from "@pm-go/planner";

export interface ReviewActivityDeps {
  reviewerRunner: ReviewerRunner;
  /** Claude model id. When unset, the reviewer package default applies. */
  reviewerModel?: string;
}

/**
 * Task-level review activities. Phase 4 splits "persist review" and "run
 * reviewer" into separate activity factories so each can be wired with
 * only the deps it needs: `runReviewer` takes the injected runner (stub
 * or Claude-backed), and `persistReviewReport` / policy decisions live in
 * {@link createReviewPersistenceActivities}.
 */
export function createReviewActivities(deps: ReviewActivityDeps) {
  return {
    async runReviewer(input: {
      task: Task;
      worktreePath: string;
      baseSha: string;
      headSha: string;
      cycleNumber: number;
      previousFindings?: ReviewFinding[];
      workflowRunId?: string;
      parentSessionId?: string;
    }): Promise<{ report: ReviewReport; agentRun: AgentRun }> {
      const strictness = resolveStrictness(input.task);

      const result = await runReviewerPkg({
        task: input.task,
        worktreePath: input.worktreePath,
        baseSha: input.baseSha,
        headSha: input.headSha,
        strictness,
        cycleNumber: input.cycleNumber,
        ...(input.previousFindings ? { previousFindings: input.previousFindings } : {}),
        ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        requestedBy: "task-review-workflow",
        runner: deps.reviewerRunner,
        ...(deps.reviewerModel !== undefined ? { model: deps.reviewerModel } : {}),
      });

      // Ensure the report's taskId matches the task under review. Stub
      // runners and malformed model output can drift here; fail loud.
      if (result.report.taskId !== input.task.id) {
        throw new Error(
          `runReviewer: reviewer returned a report for taskId ${result.report.taskId} but this run is for ${input.task.id}`,
        );
      }

      return result;
    },
  };
}

/**
 * Derive reviewer strictness from the task's `reviewerPolicy.strictness`
 * when set, else fall back to the risk-level default:
 *   low → standard, medium → elevated, high → critical.
 *
 * Keeping this coupling in one place means the workflow layer doesn't
 * have to know the mapping; it just hands off the task and trusts the
 * activity to pick the right strictness.
 */
function resolveStrictness(task: Task): ReviewStrictness {
  const stored = task.reviewerPolicy.strictness;
  if (
    stored === "standard" ||
    stored === "elevated" ||
    stored === "critical"
  ) {
    return stored;
  }
  switch (task.riskLevel) {
    case "high":
      return "critical";
    case "medium":
      return "elevated";
    default:
      return "standard";
  }
}

// Re-export helpers used by a few API consumers and tests. The persistence
// activities live in `./review-persistence.ts`.
export type { UUID };
