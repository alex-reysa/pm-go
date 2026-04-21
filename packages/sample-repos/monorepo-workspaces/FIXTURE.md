# Fixture: monorepo-workspaces

## Shape

- pnpm workspaces root (`pnpm-workspace.yaml` + `"workspaces"` in `package.json`)
- Two workspace packages under `packages/`:
  - `@phase7-fixture/core` — pure leaf package with one exported value
  - `@phase7-fixture/app`  — depends on `@phase7-fixture/core` via `workspace:*`
- Shared `tsconfig.base.json` at the repo root, one `tsconfig.json` per workspace

## What it exercises

- `repo-intelligence` detects multiple workspaces and returns a non-trivial
  package graph; the matrix smoke asserts the stub runner chain still
  works when `fileScope.packageScopes` could legitimately span two
  packages.
- `worktree-manager` against a monorepo: one integration branch, one
  lease, multiple package directories.
- Planner prompt surface: a realistic "which workspace does this task
  belong to?" signal.

## Not exercising

- Nested package boundaries (see `nested-packages`).
- TS project references (see `ts-project-references`).

## Invocation

Driven by `scripts/phase7-matrix.sh` — the harness copies this directory
into a tmpdir and runs the matrix smoke against it against stub executors.
