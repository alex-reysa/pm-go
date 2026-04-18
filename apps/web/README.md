# Web App

This package will host the Next.js operator UI.

Primary responsibilities:

- render plan graphs, task state, review findings, and merge queue state
- expose operator controls for approvals, retries, and policy decisions
- subscribe to durable event streams from the control-plane API

Do not place orchestration logic here. The UI is a consumer of workflow state, not the owner of it.

## Phase 1a status

Full Next.js 15 + React 18 toolchain setup is deferred to **Phase 6**. The
`package.json` in this directory is intentionally a compile-safe stub with no
framework dependencies and no `typecheck` or `test` scripts, so the workspace
`pnpm -r --if-present` runners skip it cleanly. Do not add Next.js, React, or
build tooling here until Phase 6 kicks off.

