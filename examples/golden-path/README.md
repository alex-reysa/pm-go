# Golden Path Example

This directory contains the smallest realistic feature spec for learning pm-go:

- [spec.md](spec.md): add a phase-scoped API endpoint.
- [phase3-task-index.json](phase3-task-index.json): fixture metadata used by
  smoke tests.

Use it when you want to see the product path without inventing a new spec.

## What This Example Proves

The spec is intentionally narrow. It gives the planner enough context to create
one or more scoped implementation tasks, and it gives the reviewer/auditor clear
acceptance criteria:

- validate `planId` and `phaseId`;
- return `404` separately for missing plan and missing phase;
- return phase and task data from existing tables;
- add unit tests;
- avoid unnecessary contract, database, or worker changes.

In stub mode, pm-go uses fixtures to exercise the control plane. In live mode,
Claude-backed runners perform the actual planning, implementation, review, and
audit work.

## Run It End To End

From the repo root, follow the canonical guide:

```bash
pnpm install
cp .env.example .env
pnpm docker:up
pnpm db:migrate
```

Then open separate terminals for the long-running processes:

```bash
pnpm dev:worker
```

```bash
pnpm dev:api
```

```bash
pnpm tui
```

Then submit `examples/golden-path/spec.md` with the commands in
[docs/getting-started.md](../../docs/getting-started.md).

The expected operator loop is:

1. Submit the spec through `POST /spec-documents`.
2. Start planning with `POST /plans`.
3. Open the generated plan in the TUI.
4. Run tasks with `g r`.
5. Review with `g v`; fix with `g f` if needed.
6. Integrate the phase with `g i`.
7. Audit the phase with `g a`.
8. Complete and release with `g c` then `g R`.

## Planner-Only Smoke

The older Phase 2 smoke still uses this directory to prove spec intake and plan
persistence only:

```bash
pnpm smoke:phase2
```

That smoke:

1. boots the worker and API;
2. posts [spec.md](spec.md) to `POST /spec-documents`;
3. starts `SpecToPlanWorkflow` through `POST /plans`;
4. waits for the plan to persist;
5. verifies plan rows and the rendered plan artifact.

Use `pnpm smoke:phase7` or the TUI walkthrough when you want the full
feature-to-release path.
