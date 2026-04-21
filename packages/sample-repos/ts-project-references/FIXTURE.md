# Fixture: ts-project-references

## Shape

- Root `tsconfig.json` with `"files": []` and `"references"` pointing at
  two inner projects (`packages/shared`, `packages/consumer`)
- Each inner project has its own `tsconfig.json` and `src/index.ts`
- The consumer project declares a TS reference back to the shared project
- **Not** a pnpm workspace — package boundaries are drawn purely by
  TypeScript's build graph

## What it exercises

- `repo-intelligence` against a TS-project-references shape: the
  package graph is in `tsconfig.json`, not `package.json` deps.
- The planner's ability to produce a plan against a repo where "which
  package does this file live in?" is answered by the TS build graph.
- Stub implementer + reviewer round-trip when file edits might touch
  either referenced project.

## Not exercising

- Full TS project-references rebuild (`tsc -b`) — the matrix smoke does
  not type-check the fixture; it only proves the stub chain survives
  the shape.

## Invocation

Driven by `scripts/phase7-matrix.sh` — the harness copies this directory
into a tmpdir and runs the matrix smoke against it against stub executors.
