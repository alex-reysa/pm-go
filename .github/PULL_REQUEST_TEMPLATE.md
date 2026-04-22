<!-- Thanks for contributing to pm-go. Please fill out the sections below. -->

## Summary

<!-- 1–3 bullets on what changed and why. Link the issue, phase doc, or runbook driving this. -->

## Changes

<!-- Notable files touched. Call out anything cross-cutting (contracts, migrations, workflow signatures). -->

## Migrations / Env / Scripts

<!-- New db/migrations/*.sql? New env vars? New smoke flags? List them here so reviewers don't miss them. Otherwise: "None". -->

## Test Plan

- [ ] `pnpm typecheck`
- [ ] `pnpm test` (or affected packages)
- [ ] `pnpm smoke:phase7-matrix` (if touching planner / executor / reviewer / integration)
- [ ] `pnpm smoke:phase7-chaos` (if touching retry / stop / budget / worktree / durable-state)
- [ ] Manual verification (describe):

## Docs

- [ ] Updated relevant docs under `docs/` or `docs/runbooks/`
- [ ] N/A — no behavior-visible change

## Notes for Reviewers

<!-- Anything reviewers should pay extra attention to, known limitations, follow-ups filed as issues, etc. -->
