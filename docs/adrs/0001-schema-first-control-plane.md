# ADR 0001: Schema-First Control Plane With Temporal And Claude

## Status

Accepted

## Context

The product needs to coordinate long-running, interruptible, review-heavy software delivery tasks. A single recursive agent loop would place too much state into prompt context and make failures hard to resume or audit.

## Decision

Adopt a two-layer architecture:

- Claude-based execution layer for implementers and reviewers
- Temporal-based orchestration layer for durable state, retries, approvals, merge sequencing, and stop conditions

Persist orchestration state in Postgres and treat typed contracts as the system of record. Render markdown artifacts for humans only after structured state exists.

## Consequences

Positive:

- workflows are resumable
- policy decisions are auditable
- merge order is deterministic
- review independence is enforceable

Tradeoffs:

- more upfront infrastructure than a single agent loop
- stronger need for contract discipline
- workflow/activity boundaries must be kept clean

## Follow-On Decisions

- choose concrete persistence tooling for Postgres
- define executor adapter interface for Claude SDK integration
- define exact worktree cleanup and lease expiration behavior

