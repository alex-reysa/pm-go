# ADR 0003: Postgres Migration And Query Toolchain

## Status

Proposed

## Context

Postgres is the system of record for orchestration state per ADR 0001 and `db/README.md`, holding tables such as `spec_documents`, `plans`, `plan_tasks`, `agent_runs`, `worktree_leases`, and `policy_decisions`. The schema-first ethos of this project means TypeScript contracts, JSON Schema (see ADR 0002), and SQL tables must stay structurally aligned without duplication. V1 migrations are linear and simple, and destructive migrations are classified as high risk per `task-routing-and-limits.md`. The chosen toolchain shapes how every Temporal activity reads and writes durable state, so it must be fixed before Phase 1b begins.

## Decision

Pending. Three candidates under evaluation:

- `Drizzle ORM` — schema declared in TypeScript, migrations generated via `drizzle-kit` as plain SQL, type-safe query builder with SQL-shaped ergonomics. Small runtime. Lighter than `Prisma`, more ergonomic than raw SQL.
- `Prisma` — mature DX, schema lives in a `.prisma` DSL, first-class migrations, heavier runtime with a separate query engine, code generation step. Historically weaker on complex SQL and pooling, actively improving.
- `Kysely` plus `node-pg-migrate` — hand-written SQL migrations plus a strongly-typed query builder. Most control, least magic, highest ceremony.

Recommend `Drizzle` because:

- schema is TypeScript, matching the contracts in `packages/contracts`
- generated migrations are plain SQL and human-reviewable
- no separate runtime like `Prisma`'s query engine
- integrates cleanly with Temporal activities that need low-overhead connections

`Kysely` is the fallback if the team prefers zero ORM abstraction. `Prisma` is explicitly deprioritized because its second schema DSL conflicts with the "one source of truth" principle of ADR 0001 and ADR 0002.

## Consequences

Positive:

- one schema definition in TypeScript, aligned with the contracts package
- migrations are plain SQL, auditable, and fit the "destructive migration = high risk" policy
- low runtime overhead inside Temporal activities

Tradeoffs:

- `Drizzle` is younger than `Prisma` and has a smaller community
- complex queries may require escape hatches to raw SQL
- migration rollback tooling is thinner than `Prisma`'s

## Follow-On Decisions

- confirm migration placement: `db/migrations/*.sql` at repo root vs. `packages/*/migrations`
- decide on a connection pool: `pg` native pool vs. `postgres.js` (`Drizzle` supports both)
- decide whether Temporal activities receive a `Drizzle` client or a thinner repository interface
- confirm seed-data strategy for the golden-path example
