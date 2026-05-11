# Desktop renderer test notes

## Workspace validation: known TUI flake (not caused by this changeset)

During task `renderer-live-data-tests` (acceptance criterion `14f4b262`), running
the full workspace command `pnpm test` from the repository root surfaced a
pre-existing, intermittent failure in the TUI package. The new tests added by
this changeset live exclusively under `apps/desktop/test/renderer/**` and do not
touch any TUI code or fixtures.

- **Failing test:** `PlanDetailScreen > enter on a task navigates to the task drawer`
- **File:** `apps/tui/test/plan-detail.test.tsx` (the `it(...)` at line 213)
- **Symptom under workspace runner:** vitest reports `onNavigate` was called 0
  times instead of 1 — the simulated `Enter` keypress occasionally lands before
  the `useInput` hook is mounted because the workspace runner schedules many
  ink/react roots in parallel.
- **Package-level rerun (passes deterministically):**
  ```sh
  pnpm --filter @pm-go/tui test
  ```
  In isolation the suite passes; the failure only reproduces when `pnpm test`
  fans out across all workspace packages at once.
- **Diagnosis:** Pre-existing TUI plan-detail input-timing flake, unrelated to
  the renderer-only additions in this changeset. The renderer tests added here
  do not import from `apps/tui/**`, do not modify shared fixtures, and pass
  under `pnpm --filter @pm-go/desktop test`.

If the workspace-level `pnpm test` fails on exactly the test above (and only on
that test), re-run the TUI package in isolation with the command above to
confirm it is the same flake. Any other failure should be treated as a real
regression and investigated.
