# Completion Audit

This phase answers a narrower question than "did the workflows finish?"

It answers: did the merged repository state actually satisfy the approved spec,
task graph, review requirements, and release gates?

## Purpose

The system should never treat agent completion alone as proof of correctness.
After implementers, reviewers, and integrators finish, the control plane should
run a final independent audit over the merged state.

That audit is the durable source of truth for release readiness.

## Inputs

The completion audit should read from durable records, not prompt memory:

- approved `Plan`
- all `Task` records and dependency state
- every phase's `MergeRun` state and the final integration head
- `ReviewReport` records and any open findings
- validation and test artifacts
- `PolicyDecision` records
- generated PR/release summary artifacts

## Required Checks

At minimum, the audit checklist should verify:

1. every required task is merged, waived explicitly, or still blocked with a
   recorded reason
2. every required acceptance criterion is mapped to evidence or marked missing
3. no blocking review findings remain unresolved
4. no unresolved policy decisions remain for the release scope
5. the final repo state matches the artifacts being proposed for release
6. the completion audit itself is running against the latest merged head

## Outputs

The workflow should produce:

- a `CompletionAuditReport`
- the audited merged head SHA
- structured findings for gaps or regressions
- a checklist with evidence artifact references
- a release-readiness verdict of `pass`, `changes_requested`, or `blocked`

## Failure Semantics

Completion audit failure should not be treated as a cosmetic release warning.

If the audit fails:

- the plan should return to a blocked or follow-up-needed state
- new implementation or fix tasks may be created from the findings
- release finalization should be refused until a fresh audit passes

## Design Constraint

The completion audit is not a replacement for task review. It is a second-order
verification layer over the integrated result.
