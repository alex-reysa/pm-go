# Fixture: single-package

## Shape

- Flat npm package, `package.json` + `tsconfig.json` at the root
- Single `src/index.ts` with a trivial exported function
- No workspaces, no submodules, no package boundaries

## What it exercises

- The **simplest** phase5 happy-path: planner → implementer (stub writes a
  file under `phase7-matrix/<slug>.txt`) → reviewer (stub pass) →
  integrate → audit → complete. Serves as the baseline green run for the
  matrix harness — if this fixture fails, everything else is suspect.
- `repo-intelligence` surface-area detection against a plain TS package.
- `worktree-manager` lease + commit against a minimal git repo.

## Not exercising

- Workspace resolution, project references, nested boundaries — those
  live in the other three fixtures.

## Invocation

Driven by `scripts/phase7-matrix.sh` — the harness copies this directory
into a tmpdir, `git init`s it, and runs the matrix smoke against it.
