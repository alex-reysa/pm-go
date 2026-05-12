# Completion audit typed evidence refs

## Objective

Bug #22 blocks the release gate after the completion-auditor worktree fix:
the auditor can produce a coherent `CompletionAuditReport`, but validation
rejects checklist evidence values such as `review:<uuid>`, `policy:<uuid>`,
`mergerun:<uuid>`, `commit:<sha>`, and `diff:<range>` because
`CompletionChecklistItem.evidenceArtifactIds` currently accepts only bare
UUIDs.

The contract should represent the evidence the auditor actually reasons over.
Completion audit evidence is not only artifact rows; it also includes review
reports, phase audits, merge runs, policy decisions, commits, and diff ranges.

## Decision

Adopt typed evidence references. Do not normalize typed refs to bare UUIDs in
the persistence path.

Normalizing would lose the durable kind (`review` vs `policy` vs `mergerun`)
and has no honest bare-UUID representation for `commit:<sha>` or
`diff:<range>`. The release gate should preserve that provenance so operators
and future desktop views can explain why a checklist item passed or failed.

## Contract

Introduce a shared `EvidenceRef` string type and allow
`CompletionChecklistItem.evidenceArtifactIds` to contain `EvidenceRef[]`
instead of `UUID[]`.

Accepted refs:

- `artifact:<uuid>` for rows in `artifacts`
- `review:<uuid>` for rows in `review_reports`
- `phase-audit:<uuid>` for rows in `phase_audit_reports`
- `mergerun:<uuid>` for rows in `merge_runs`
- `policy:<uuid>` for rows in `policy_decisions`
- `commit:<40-hex-sha>` for an audited commit
- `diff:<40-hex-sha>..<40-hex-sha>` for a git diff range

Backward compatibility: existing bare UUID values remain valid and are
interpreted as legacy artifact refs. New runner output should prefer the typed
forms above.

This is a wire-contract change for both phase and completion audit reports
because both share `CompletionChecklistItem`. No database migration is needed;
the checklist payload is already persisted as JSON.

## Implementation Plan

1. Update `packages/contracts/src/review.ts` with `EvidenceRef` and change
   `CompletionChecklistItem.evidenceArtifactIds` to `EvidenceRef[]`.
2. Update the TypeBox schema in
   `packages/contracts/src/validators/orchestration-review/completion-checklist-item.ts`
   with a union of bare UUID plus the typed-ref regexes above.
3. Add contract tests that accept each typed ref and reject malformed prefixes,
   bad UUIDs, short SHAs, and diff ranges without two 40-character SHAs.
4. Update completion-auditor and phase-auditor fixtures to include at least one
   typed ref while keeping one bare UUID regression fixture.
5. Update the completion-auditor user prompt to name the accepted typed refs.
   Keep the model-side instruction narrow: evidence refs must be drawn from
   IDs and SHAs present in the prompt or from the audited diff range.
6. Add an executor regression test using a structured completion-auditor output
   with `review:`, `policy:`, `mergerun:`, `commit:`, and `diff:` refs to prove
   validation reaches the normal report persistence path.

## Acceptance Criteria

- `validateCompletionAuditReport` accepts the diagnostic shape from bug #22
  when the refs match the typed formats.
- `validatePhaseAuditReport` still accepts existing reports with bare UUID
  evidence refs.
- Malformed evidence refs produce the structured schema diagnostics added in
  `c57567e`, including the failing checklist path and offending value.
- Re-running completion audit for plan
  `73bd9a65-4304-4d13-9807-68c4f27a047c` no longer fails schema validation
  because of prefixed evidence refs. The audit may still return `pass`,
  `changes_requested`, or `blocked` based on its substantive findings.

## Non-goals

- Do not add a second checklist field such as `evidenceRefs`; this slice widens
  the existing contract rather than supporting two competing evidence paths.
- Do not create synthetic artifact rows for commits or diffs just to obtain a
  UUID.
- Do not alter release eligibility semantics. Release still requires the latest
  completion audit to have `outcome === "pass"`.
