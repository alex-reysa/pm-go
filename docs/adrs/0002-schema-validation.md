# ADR 0002: TypeScript Schema Validation Library

## Status

Accepted

## Context

Contracts in `packages/contracts` must validate at runtime at every trust boundary: HTTP request ingress, Temporal activity input and output, Postgres row parsing, and Claude Agent SDK structured-output payloads. The validator must also emit JSON Schema because the executor adapter passes schemas to the Agent SDK `outputFormat: { type: 'json_schema', schema }` option. The shared `tsconfig.base.json` sets `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`, so the validator must preserve those semantics rather than widen them. This choice locks in significant downstream syntax across every package, so the record matters even before sign-off.

## Decision

We adopt **`@sinclair/typebox`** (installed at `^0.34.0` in `packages/contracts`) as the single schema validation library for the entire `pm-go` monorepo. JSON Schema is TypeBox's native representation, so the same schema artifact feeds HTTP validation, Postgres parsing, and the Claude Agent SDK `outputFormat: { type: 'json_schema', schema }` integration without any lossy transform. Contract types in `packages/contracts/src/*.ts` will be derived from schemas via `Static<typeof Schema>` once the per-contract lanes land, keeping a single source of truth.

## Consequences

Positive:

- structured-output payloads from the Agent SDK validate against the same artifact used in Postgres and HTTP layers
- no divergence between runtime validation and emitted JSON Schema
- types can be inferred from schemas via `Static<>`, removing a duplicate source of truth
- TypeBox has strong runtime performance on hot paths between HTTP ingress and Temporal activities

Tradeoffs:

- TypeBox DSL is less ergonomic than Zod for complex refinements; contributors may need to reach for `Type.Unsafe` or custom format validators
- smaller community and fewer third-party integrations than Zod
- `exactOptionalPropertyTypes` interaction requires care; TypeBox `Optional` needs explicit `undefined` unions or the `ExactOptionalPropertyTypes` option on the type builder

## Follow-On Decisions

- benchmark validator cost on the hot path from HTTP request to activity input to confirm no regression against Zod
- decide whether contract types in `packages/contracts/src/*.ts` are hand-written TypeScript types mirrored by schemas, or inferred from `Static<typeof Schema>`; recommend inferring from schemas to keep a single source of truth
