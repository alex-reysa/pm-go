/**
 * Optional override for the Claude Code native binary path the
 * `@anthropic-ai/claude-agent-sdk` `query()` call spawns.
 *
 * The SDK auto-detects its bundled native binary inside
 * `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-<platform>-<arch>@<v>/...`
 * by default. The auto-detection has been observed to fail on macOS
 * checkouts whose absolute path contains spaces or other unusual
 * characters — the SDK reports "Claude Code native binary not found at
 * <path>" with `existsSync(<path>) === true`. Symptom: the
 * CompletionAuditWorkflow fails 4 times in a row and the plan row stays
 * at `approved` instead of `released`.
 *
 * `PM_GO_CLAUDE_BINARY=/abs/path/to/claude` opts into an explicit
 * override that the SDK threads through a different code path; setting
 * it to the very same path the auto-detect error reported has been
 * observed to make the call succeed.
 *
 * No env var set → returns an empty object so existing callers keep
 * the SDK's default behavior. The override is therefore strictly
 * additive — the only risk surface is the explicit path being wrong,
 * which surfaces immediately as the same "binary not found" error the
 * operator was trying to fix.
 *
 * The env var is read at activity-execution time, so a stack restart
 * (`pm-go stop && pm-go run ...`) is enough to pick up a change to
 * `.env`.
 */
export function claudeBinaryOption(): { pathToClaudeCodeExecutable?: string } {
  const explicit = process.env.PM_GO_CLAUDE_BINARY;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return { pathToClaudeCodeExecutable: explicit.trim() };
  }
  return {};
}
