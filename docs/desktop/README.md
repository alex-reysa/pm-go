# pm-go Desktop Docs

This directory defines the product, architecture, API boundary, dogfood plan,
and release bar for the pm-go Desktop MVP.

Use it as the source pack for designing and implementing Desktop without
turning the app into a second orchestrator. Desktop is an attach-first Electron
operator surface for the existing pm-go control-plane API.

The static prototype under `front-end/` is a design artifact to compare against
this pack. It is not the source of truth for MVP scope. When the prototype and
these docs disagree, preserve the attach-first API boundary, run-scoped IA, and
Workflow Builder limits defined here.

## Understand the product

- [Product brief](01-product-brief.md): use when you need the product purpose,
  users, principles, core loop, non-goals, and MVP success criteria.
- [MVP scope](02-mvp-scope.md): use when deciding what the first Desktop app
  must include, what is out of scope, and which screens/actions are required.
- [Information architecture](03-information-architecture.md): use when shaping
  routes, screen responsibilities, progressive disclosure, the event drawer,
  inspector behavior, and prototype alignment.

## Build the app boundary

- [Desktop architecture](04-desktop-architecture.md): use when implementing the
  Electron main/preload/renderer split, host integrations, security boundaries,
  config storage, path handling, and packaging assumptions.
- [API integration](05-api-integration.md): use when wiring Desktop to
  `apps/api`, modeling reads, handling SSE/replay, showing API errors, and
  mapping operator actions to endpoints.

## Plan Workflow Builder work

- [Workflow Builder domain](06-workflow-builder-domain.md): use when discussing
  the future graph surface and its Level 1 read-only boundary.
- [Node and workflow types](07-node-and-workflow-types.md): use when projecting
  durable pm-go records into graph nodes, edges, gates, evidence references,
  and future template vocabulary.

## Dogfood and release

- [Dogfood plan](08-dogfood-plan.md): use when turning this pack into bounded
  pm-go specs and milestone runs against pm-go itself.
- [Test and release plan](09-test-and-release-plan.md): use when defining the
  validation layers, release gates, golden path, manual QA, and release-blocking
  failures.

## Recommended reading order

1. Start with [Product brief](01-product-brief.md) to understand why Desktop
   exists and what it must not become.
2. Read [MVP scope](02-mvp-scope.md) and
   [Information architecture](03-information-architecture.md) together before
   designing screens or routes.
   Compare the `front-end/` draft at this point, especially its Dashboard,
   global Approvals/Artifacts, Settings, event drawer, and Workflow Builder
   choices.
3. Read [Desktop architecture](04-desktop-architecture.md) before creating
   Electron code or host integrations.
4. Read [API integration](05-api-integration.md) before building live data,
   actions, SSE, artifacts, or error handling.
5. Read [Dogfood plan](08-dogfood-plan.md) before writing pm-go specs.
6. Read [Test and release plan](09-test-and-release-plan.md) before declaring a
   milestone or package releasable.
7. Read [Workflow Builder domain](06-workflow-builder-domain.md) and
   [Node and workflow types](07-node-and-workflow-types.md) only when working
   on the optional read-only workflow preview or future builder design.

## Dependency order

The docs build on each other in this order:

```text
01 product brief
02 MVP scope
03 information architecture
04 desktop architecture
05 API integration
08 dogfood plan
09 test and release plan
```

Workflow Builder docs are secondary to the MVP operator loop:

```text
06 workflow builder domain
07 node and workflow types
```

Treat `06` and `07` as dependent on the product and architecture boundaries in
`01` through `05`. They do not override the attach-first MVP or the durable
control-plane API boundary.

## Dogfood pm-go Desktop

Use this docs pack to create small pm-go specs, not one broad "build Desktop"
request.

1. Start from the milestone slicing in [Dogfood plan](08-dogfood-plan.md).
2. For each spec, cite the specific source docs for that milestone.
3. Keep Desktop attached to an already-running stack; do not add stack
   supervision, direct Postgres, direct Temporal, Docker, or git worktree
   mutation in MVP specs.
4. Use [API integration](05-api-integration.md) as the rule for every read,
   mutation, artifact fetch, event stream, and server-authoritative action.
5. Use [Test and release plan](09-test-and-release-plan.md) to choose validation
   commands, manual checks, evidence to capture, and release-blocking failures.

If a dogfood run exposes a missing API capability, write a narrow API
improvement spec instead of bypassing the control plane from Desktop.
