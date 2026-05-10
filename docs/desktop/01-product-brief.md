# pm-go Desktop Product Brief

## Purpose

pm-go Desktop is the desktop operator surface for `pm-go`: a durable control
plane for AI-assisted software delivery.

It helps an operator take a feature spec and local repository from intent to
release evidence. The app should make the existing control-plane loop visible
and controllable: ingest a spec, create a structured plan, partition work into
bounded tasks, execute implementation agents in isolated worktrees, review and
fix diffs, integrate in dependency order, run audits, and release only when the
durable evidence passes.

Desktop is not a separate orchestrator. It should present and drive the same
durable state exposed by the API, worker, contracts, git worktree manager,
policy engine, and audit artifacts.

## Users

pm-go Desktop serves operators who need AI-assisted software delivery to be
inspectable and bounded rather than chat-driven.

- Solo maintainers running pm-go against local repos.
- Engineering leads coordinating multi-step changes before review or merge.
- Staff engineers and technical PMs who need plan, risk, budget, approval, and
  release evidence in one place.
- pm-go contributors dogfooding the system against pm-go itself.

The primary user is technical. They understand repos, branches, diffs, tests,
and review findings, but they should not need to remember API calls, workflow
IDs, or terminal keybindings to operate a run safely.

## Why Desktop Exists

The CLI and TUI are good for automation, debugging, and keyboard-first power
use. Desktop exists because the product loop is long-running, stateful, and
evidence-heavy.

The desktop app should improve the workflow by:

- making the current run state easy to inspect without reading logs or events
  line by line
- keeping approvals, budgets, blocked tasks, findings, audits, and release
  readiness visible at the moment they matter
- supporting pause, resume, recovery, and review across long-running sessions
- reducing operator error by making the next valid actions explicit
- giving future Workflow Builder work a clean product foundation without
  overloading the initial app

Desktop should make pm-go easier to trust, not more autonomous.

## Core Product Loop

1. Select a local repository and feature spec.
2. Capture a durable repo snapshot.
3. Generate and inspect a structured plan.
4. Review phases, risks, task boundaries, budgets, and approval gates.
5. Start or continue execution.
6. Monitor task worktrees, agent runs, reviews, fix loops, and policy decisions.
7. Resolve blockers through explicit approvals, fixes, overrides, or other
   API-supported recovery actions.
8. Integrate completed tasks in phase dependency order.
9. Review phase audit results before advancing.
10. Run the final completion audit against the merged repository state.
11. Produce release evidence and PR-ready output only after the audit passes.

The app should keep this loop understandable even when many entities exist
underneath it. The main screen should answer: what is happening, what needs
attention, what evidence exists, and what can safely happen next.

## Product Principles

### Durable State First

The source of truth is persisted control-plane state, not the desktop process,
chat memory, or a transient UI model. Plans, phases, tasks, agent runs,
worktree leases, policy decisions, reviews, merge runs, audits, artifacts, and
events must remain inspectable after restarts.

### Bounded Autonomy

Agents operate inside explicit constraints. Tasks have file scopes, budgets,
review policies, risk levels, dependency edges, and worktree leases. The UI
should expose those bounds clearly and escalate when a run wants to exceed
them.

### Evidence-Based Completion

The app must not present work as complete because an agent finished. Completion
requires durable evidence: accepted scope, reviewed diffs, validation output,
merge metadata, phase audit results, and a passing completion audit against the
merged state.

### Human Control At Policy Boundaries

Desktop should make approval gates first-class. High-risk work, budget
pressure, scope violations, stale worktrees, failed audits, and retries should
be explicit operator decisions with enough context to act.

### Progressive Disclosure

The UI should stay clean and intuitive. It should show the operator the current
run, the next decision, and the evidence behind that decision without permanent
panels for every subsystem. Detailed logs, spans, task internals, raw events,
and artifact metadata should be available on demand.

### Local-First Operation

MVP Desktop is for local repo execution. It should work with the existing local
stack and respect the same resumability, worktree, and release-readiness rules
as the CLI and TUI.

## MVP Product Shape

The MVP should provide a focused, attach-first operator console for local
pm-go runs. It can list existing plans and open one selected run at a time for
operation, but it does not start or supervise the pm-go stack.

It should let the user:

- choose a local repo and spec document
- create a new spec-backed run through the API
- resume an existing run from the API-backed runs list
- inspect plan, phase, task, review, policy, merge, and audit state
- see the current blocker or next valid action
- run, review, fix, approve, override, integrate, audit, complete, and release
  only through current control-plane API endpoints when server state permits
- inspect evidence artifacts needed to trust the result

The MVP should not try to be a general project management system. Its job is
to make the existing pm-go delivery loop legible and operable.

Actions such as cancel, stop, generic continue, lease extension, direct
re-audit aliases, and run-to-completion drive loops are future API/product work
unless they are added as explicit control-plane endpoints.

## Non-Goals

- replacing the CLI for automation or scripting
- replacing the TUI for lightweight terminal operation
- autonomous production deploys
- cross-repo execution graphs
- arbitrary runtime-generated agent roles
- open-ended recursive agent systems
- markdown-only planning
- model-owned merge order
- unbounded long-term memory
- multi-user hosted collaboration
- the node-based Workflow Builder in the first desktop MVP

## MVP Success Criteria

pm-go Desktop is successful for the first MVP when an operator can:

1. start from a local repo and spec without manual API calls
2. understand the generated plan, phase order, risks, and task boundaries
3. see active work, blocked work, review findings, budget state, and approval
   needs without reading raw logs first
4. make every required human decision from durable context
5. recover or resume a run after process restart
6. verify that integration and release readiness are based on audit evidence
7. produce PR-ready output only after the completion audit passes

## Future Direction

The later Workflow Builder should build on this foundation. It can expose a
node-based view of plans, phases, gates, and custom delivery flows only after
the desktop app proves the core operator loop is clear, durable, and safe.
