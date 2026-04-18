# ADR 0002: TypeScript Schema Validation Library

## Status

Proposed

## Context

Contracts in `packages/contracts` must validate at runtime at every trust boundary: HTTP request ingress, Temporal activity input and output, Postgres row parsing, and Claude Agent SDK structured-output payloads. The validator must also emit JSON Schema because the executor adapter passes schemas to the Agent SDK `outputFormat: { type: 'json_schema', schema }` option. The shared `tsconfig.base.json` sets `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`, so the validator must preserve those semantics rather than widen them. This choice locks in significant downstream syntax across every package, so the record matters even before sign-off.

## Decision

Pending. Candidates under review:

- `Zod` 3.x with `zod-to-json-schema`: most mature TypeScript ecosystem fit and an ergonomic DSL, but imposes runtime overhead on hot paths and treats JSON Schema emission as a secondary transform that is lossy on some refinements. Pairs well with `@hono/zod-openapi` if REST OpenAPI is added later.
- `TypeBox`: produces JSON Schema as its native representation with no lossy transform, excellent runtime performance, and infers types from schemas via `Static<>`. DSL is less ergonomic than Zod for complex refinements. Battle-tested in the Fastify ecosystem.
- `Valibot`: modular and bundle-size friendly, with JSON Schema emission via `@valibot/to-json-schema`. Emission path is newer and less proven. Bundle size is less relevant for server-side `pm-go`.

Recommendation: `TypeBox`. JSON Schema is a first-class concern for the executor adapter, not a bolt-on, and a single artifact should serve HTTP validation, Postgres parsing, and Agent SDK structured output. The counter-argument is Zod's broader ecosystem momentum and better ergonomics for refined types; the decision is defensible either way and should be confirmed by the benchmark called out below.

## Consequences

Positive:

- structured-output payloads from the Agent SDK validate against the same artifact used in Postgres and HTTP layers
- no divergence between runtime validation and emitted JSON Schema
- types are inferred from schemas, removing a duplicate source of truth

Tradeoffs:

- TypeBox DSL is less ergonomic than Zod for complex refinements
- smaller community and fewer third-party integrations than Zod
- `exactOptionalPropertyTypes` interaction requires care; TypeBox `Optional` needs explicit `undefined` unions or the `ExactOptionalPropertyTypes` option

## Follow-On Decisions

- benchmark validator cost on the hot path from HTTP request to activity input to confirm no regression against Zod
- decide whether contract types in `packages/contracts/src/*.ts` are hand-written TypeScript types mirrored by schemas, or inferred from `Static<typeof Schema>`; recommend inferring from schemas to keep a single source of truth
