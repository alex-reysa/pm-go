# Security Policy

## Supported Versions

`pm-go` is pre-1.0. Only the `main` branch is supported. Security fixes land on `main` and are not backported.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security reports.**

Report vulnerabilities privately via one of:

1. GitHub's private vulnerability reporting — open a [Security Advisory](https://github.com/alex-reysa/pm-go/security/advisories/new) on this repository.
2. Email the maintainers directly (see the repository owner on GitHub).

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, including the affected commit SHA.
- Any proof-of-concept code or logs you can share.

You should receive an acknowledgement within 5 business days. We aim to triage, patch, and disclose coordinated within 30 days for high-severity issues; lower severity on a best-effort basis.

## Scope

In scope:

- The orchestration layer (`apps/api`, `apps/worker`, `packages/*`) — policy gate bypasses, authentication/authorization flaws on API endpoints, SQL injection, path traversal (note: Phase 6 ships realpath-containment on `/artifacts/:id`), workflow-determinism or replay-state corruption vectors.
- Secret-handling in `.env` loading, agent-run persistence, and artifact emission.
- Git worktree / merge operations in `packages/worktree-manager/` and `packages/integration-engine/` (e.g., symlink or ref-manipulation attacks).

Out of scope:

- Anything requiring an already-compromised local machine or an already-leaked API key — rotate the key via the provider console instead.
- Denial-of-service via resource exhaustion on a local dev stack.
- Vulnerabilities in upstream dependencies without a pm-go-specific exploit path — report to the upstream project instead.

## Handling of Secrets in This Repo

- `.env` is gitignored and never committed.
- `.env.example` is a template with empty credential fields.
- If you notice a secret accidentally committed, open a Security Advisory — do not open a public issue that names the secret.
