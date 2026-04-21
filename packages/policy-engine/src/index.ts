/**
 * `@pm-go/policy-engine` — Phase 7 Worker 1.
 *
 * Pure-function evaluators consumed by Worker 4 from inside Temporal
 * activities. The entire package is side-effect-free:
 *
 *   - no I/O (no DB, no fs, no network)
 *   - no Temporal SDK imports
 *   - no `@anthropic-ai/claude-agent-sdk` imports
 *
 * Every exported function accepts plain domain values (`Task`, `Plan`,
 * `AgentRun[]`, `ReviewFinding[]`, `OperatingLimits`) and returns a
 * discriminated-union decision. The durable consequences of those
 * decisions (inserting `PolicyDecision` rows, blocking merges, etc.)
 * live outside this package.
 */

export { evaluateBudgetGate } from "./budget.js";
