import type { AgentRun } from "@pm-go/contracts";

/**
 * Build an `AgentRun` with sensible defaults for the policy-engine
 * budget tests. Callers override only the fields they care about
 * (cost, tokens, start/complete times, status).
 */
export function buildAgentRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const base: AgentRun = {
    id: "dddddddd-eeee-4fff-8000-000000000001",
    taskId: "cccccccc-dddd-4eee-8fff-000000000000",
    workflowRunId: "wf-run-test",
    role: "implementer",
    depth: 1,
    status: "completed",
    riskLevel: "medium",
    executor: "claude",
    model: "claude-opus-4-7",
    promptVersion: "implementer@1",
    permissionMode: "acceptEdits",
  };
  return { ...base, ...overrides };
}
