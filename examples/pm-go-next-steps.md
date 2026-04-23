# pm-go: Next Steps for Public OSS Repo

## Objective

Prepare and ship the pm-go OSS repo for public use. The codebase has 30 commits of Track A/B/C work (OSS hygiene, ContentFilterError, forensic agent_runs, TUI flake fixes, README/CONTRIBUTING overhaul) that are local only. Beyond pushing, the two highest-leverage improvements are: (1) letting Claude Code subscription users run pm-go without a separate funded API key, and (2) improving code quality with a set of targeted refactors.

## Scope

**Tier 1 — Ship now**

1. Push the 30 local commits to origin/main after confirming green:
   - `pnpm typecheck && pnpm test && pnpm smoke:phase7-matrix && pnpm smoke:phase7-chaos`
   - `git push origin main`
   - Cut a v0.7.0 tag

2. Drop the eager ANTHROPIC_API_KEY throw in 5 executor runners (OAuth fallthrough):
   - `packages/executor-claude/src/implementer-runner.ts` — remove `if (!apiKey) throw` guard (~lines 78–81)
   - `packages/executor-claude/src/planner-runner.ts` — remove `if (!apiKey) throw` guard (~lines 57–59)
   - `packages/executor-claude/src/claude-reviewer-runner.ts` — remove `if (!apiKey) throw` guard (~lines 79–81)
   - `packages/executor-claude/src/claude-phase-auditor-runner.ts` — remove `if (!apiKey) throw` guard (~lines 239–243)
   - `packages/executor-claude/src/claude-completion-auditor-runner.ts` — remove `if (!apiKey) throw` guard (~lines 83–87)
   - Add test in `packages/executor-claude/test/` verifying no throw at construction when apiKey is absent

**Tier 2 — Code quality (one PR)**

3. Deduplicate `waitForFrame` test helper:
   - Extract to `apps/tui/test/helpers.ts`
   - Import in `apps/tui/test/app.test.tsx` and `apps/tui/test/budget-panel.test.tsx`

4. Export `CONTENT_FILTER_ERROR_NAME` constant:
   - In `packages/executor-claude/src/errors.ts`: `export const CONTENT_FILTER_ERROR_NAME = "ContentFilterError"`
   - Replace the string literal in `packages/temporal-workflows/src/definitions.ts` `nonRetryableErrorNames` with the constant

5. Sink tests for 4 remaining runners:
   - `packages/executor-claude/test/runner-failure-sink.test.ts` already covers implementer
   - Add equivalent 4-scenario coverage (content-filter rethrow, sink-throws-but-original-propagates, non-filter-error, success-path-no-call) for: planner-runner, claude-reviewer-runner, claude-phase-auditor-runner, claude-completion-auditor-runner

6. Lint in CI:
   - Add `pnpm lint` step to `.github/workflows/ci.yml` between typecheck and test steps

## Constraints

- No changes to public API contracts or DB schema — these are internal quality improvements only
- Each Tier 2 item must leave `pnpm typecheck && pnpm test` green
- OAuth fallthrough change must not break existing tests that pass an explicit apiKey

## Acceptance Criteria

- `git push origin main` succeeds and CI passes on the pushed commits
- Constructing any executor runner with `apiKey: undefined` does NOT throw; only `runner.run()` fails at SDK call time
- `pnpm typecheck && pnpm test` green after all changes
- `CONTENT_FILTER_ERROR_NAME` constant is used in `definitions.ts` — no bare string literal `"ContentFilterError"`
- `waitForFrame` is defined once in `apps/tui/test/helpers.ts` and imported in both test files
- All 5 executor runners have sink test coverage for the 4 scenarios

## Repo Hints

- `packages/executor-claude/src/` — all 5 runner files + errors.ts
- `packages/executor-claude/test/` — existing sink tests to use as template
- `packages/temporal-workflows/src/definitions.ts` — nonRetryableErrorNames
- `apps/tui/test/` — app.test.tsx, budget-panel.test.tsx
- `.github/workflows/ci.yml` — CI workflow
