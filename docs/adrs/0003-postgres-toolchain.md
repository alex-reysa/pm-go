# ADR 0003: Postgres Migration And Query Toolchain

## Status

Accepted

## Context

Postgres is the system of record for orchestration state per ADR 0001 and `db/README.md`, holding tables such as `spec_documents`, `plans`, `plan_tasks`, `agent_runs`, `worktree_leases`, and `policy_decisions`. The schema-first ethos of this project means TypeScript contracts, JSON Schema (see ADR 0002), and SQL tables must stay structurally aligned without duplication. V1 migrations are linear and simple, and destructive migrations are classified as high risk per `task-routing-and-limits.md`. The chosen toolchain shapes how every Temporal activity reads and writes durable state, so it must be fixed before Phase 1b begins.

## Decision

Adopt the Drizzle stack for Phase 1b. Installed at repo root and in `@pm-go/db`:

- `drizzle-orm` `^0.38.0`
- `drizzle-kit` `^0.30.0`
- `pg` `^8.13.0` with `@types/pg` `^8.11.0`

Rationale: a TypeScript-native schema matches the `@pm-go/contracts` ethos (one source of truth for types, schemas, and SQL), generated migrations are plain, auditable SQL that satisfies the "destructive migration = high risk" rule, and the runtime stays lean inside Temporal activities (`pg` native pool, no separate query engine). `node-postgres` (`pg`) is chosen as the driver for its breadth of support.

`Kysely` plus `node-pg-migrate` remains the documented fallback if the team later reverses course. `Prisma` stays explicitly deprioritized because its second schema DSL conflicts with the "one source of truth" principle of ADR 0001 and ADR 0002.

## Consequences

Positive:

- one schema definition in TypeScript, co-located with the contracts package
- migrations are plain SQL, auditable, and compatible with the high-risk destructive-migration policy
- low runtime overhead inside Temporal activities

Tradeoffs:

- `Drizzle` has a smaller community than `Prisma`; complex queries may occasionally need raw SQL escape hatches
- migration rollback tooling is thinner than `Prisma`'s and must be handled with explicit SQL

## Follow-On Decisions

- confirm migration placement: `db/migrations/*.sql` at repo root vs. `packages/*/migrations`
- decide on a connection pool: `pg` native pool vs. `postgres.js` (`Drizzle` supports both)
- decide whether Temporal activities receive a `Drizzle` client or a thinner repository interface
- confirm seed-data strategy for the golden-path example
