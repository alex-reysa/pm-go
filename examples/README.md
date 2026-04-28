# Examples

This directory holds runnable example specs and templates for driving pm-go.

## What's here

| Path | What it is | When to use it |
|---|---|---|
| [`spec-input-template.md`](spec-input-template.md) | Skeleton for the spec document pm-go ingests. | Starting point when you write your own spec. |
| [`golden-path/`](golden-path/) | The smallest realistic feature spec — adds a phase-scoped GET endpoint to `apps/api`. Includes `spec.md`, a fixture (`phase3-task-index.json`), and a walkthrough README. | First-time end-to-end run. Also the spec used by the README quick start and by `pnpm smoke:phase2`. |
| [`pm-go-autopilot-v081.md`](pm-go-autopilot-v081.md) | Historical pm-go-on-pm-go spec for the v0.8.1 autopilot work. | Reference for how a meatier dogfood spec is structured. |
| [`pm-go-process-runtime.md`](pm-go-process-runtime.md) | Historical pm-go-on-pm-go spec for the v0.8.0 Claude-CLI-process runtime. | Reference for spec'ing a cross-cutting runtime change. |
| [`archive/`](archive/) | Older example specs kept for context. Not maintained. | Historical reading only. |

## Quick start

The README points at `examples/golden-path/spec.md`. From the repo root:

```bash
pm-go implement --runtime stub --spec ./examples/golden-path/spec.md
```

This boots the local stack with stub runners (no API key required) and drives
the spec from intake all the way through release using fixture-backed agents.

For a real model-driven run, drop `--runtime stub`. See
[`docs/runtimes.md`](../docs/runtimes.md) for runtime selection details.

## Writing your own spec

Copy `spec-input-template.md`, fill in each section (Title, Objective, Scope,
Out of Scope, Constraints, Acceptance Criteria, Repo Hints, Open Questions),
and pass it to `pm-go implement --spec ./my-spec.md`. The clearer the
acceptance criteria, the better the planner output and the fewer review
cycles you will see.
