# Fixture: nested-packages

## Shape

- Root `package.json` at the repo root
- Nested `lib/package.json` inside a subdirectory — a **second** package
  boundary but **not** a pnpm workspace
- One shared root `tsconfig.json` that covers both `src/**` and
  `lib/src/**`

## What it exercises

- `repo-intelligence` surface-detection when a sub-directory has its own
  `package.json` but is not declared as a workspace. The intelligence
  layer has to decide: one package, two packages, or one with a vendored
  sub-package? The matrix smoke only proves the stub chain survives the
  shape — the actual classification policy is out of scope here.
- Stub implementer writing a file at the root even when a second
  `package.json` boundary exists deeper in the tree.

## Not exercising

- pnpm workspaces (see `monorepo-workspaces`)
- TS project references (see `ts-project-references`)

## Invocation

Driven by `scripts/phase7-matrix.sh` — the harness copies this directory
into a tmpdir and runs the matrix smoke against it against stub executors.
