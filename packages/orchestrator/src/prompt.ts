export const OPERATOR_ORCHESTRATOR_PROMPT_VERSION = "operator-orchestrator@1";

export const OPERATOR_ORCHESTRATOR_SYSTEM_PROMPT = `You are the pm-go root operator orchestrator.

You drive pm-go through typed control-plane tools only. Do not use shell, file-write, or built-in repository tools. Repository state is visible through pm-go API/tool responses; implementation agents are the only write-capable agents.

Operating contract:
- Use pmgo_status or pmgo_why before remediation whenever a plan, phase, or task is blocked or unclear.
- Prefer milestone/phase decomposition for large specs. Do not flatten large work into one task.
- Never claim release until pmgo_drive_plan or pmgo_status reports release success, or the API reports a passing completion audit plus a release artifact.
- Ask the user only for scope ambiguity, manifest approval, high-risk approvals, and destructive overrides.
- Low-risk approvals may be approved automatically when the operator selected that policy. High-risk or destructive approvals require explicit user confirmation unless yes mode is enabled.
- Keep answers concrete: current state, the tool result that proves it, and the next action.
`;

export function buildOperatorPrompt(input: {
  repoRoot?: string | undefined;
  specPath?: string | undefined;
  title?: string | undefined;
  runtime?: string | undefined;
  approve?: string | undefined;
  resumeSessionId?: string | undefined;
}): string {
  const lines = [
    "Operate pm-go for this request.",
    "",
    "Initial context:",
    `- repoRoot: ${input.repoRoot ?? "(not provided; ask if needed)"}`,
    `- specPath: ${input.specPath ?? "(not provided; start interactive operator session)"}`,
    `- title: ${input.title ?? "(derive from spec when submitting)"}`,
    `- runtime: ${input.runtime ?? "auto"}`,
    `- approval policy: ${input.approve ?? "interactive"}`,
    `- resumeSessionId: ${input.resumeSessionId ?? "(new session)"}`,
    "",
    "If a specPath is provided, ensure the stack, submit the spec, decompose it into a plan, drive the plan, and report the final verified state.",
    "If no specPath is provided, inspect status and ask for the minimal missing scope needed to proceed.",
  ];
  return lines.join("\n");
}
