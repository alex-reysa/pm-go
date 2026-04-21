# `@pm-go/tui`

Terminal operator dashboard for pm-go, built on [Ink 5](https://github.com/vadimdemedes/ink) +
React 18. Consumes the Phase 5/6 HTTP + SSE surface from `apps/api`; contains no
orchestration logic of its own.

## Prerequisites

- Node 22+, pnpm 10+
- A running `apps/api` (default `http://localhost:3001`)
- Postgres + Temporal up (`pnpm docker:up`) and migrations applied (`pnpm db:migrate`)

## Run

```sh
# one-shot dev (uses tsx, no build step)
pnpm tui

# or, against a built binary
pnpm --filter @pm-go/tui build
node apps/tui/dist/index.js
```

`q` exits cleanly and restores terminal state.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `PM_GO_API_BASE_URL` | `http://localhost:3001` | Hono control-plane base URL. Trailing slashes stripped. |

Poll interval (`listRefreshIntervalMs`) and SSE reconnect backoff (`eventStreamMaxBackoffMs`)
are code-level defaults today — adjust in `src/lib/config.ts` if you need to tune them.

## Screens

| Route | Shows |
|---|---|
| Plans list (entry) | All plans from `GET /plans`, ordered by `updatedAt`. Status badge per plan. |
| Plan detail | Plan header + phase cards + task rows (grouped by phase) + live SSE event tail. A synthetic "Release ▸" row appears when `latestCompletionAudit` is set. |
| Task drawer | Task slug/title/status, file scope, acceptance criteria, budget, branch name, latest agent runs. |
| Release | Completion-audit outcome + summary + findings + artifact id list. Gated `g R` chord when outcome is `pass`. |

The event tail on plan-detail streams `phase_status_changed` / `task_status_changed` /
`artifact_persisted` events live via the `/events` SSE endpoint. When the server emits
a workflow event, the TUI invalidates the relevant react-query caches so the next
render reflects the new state.

## Keybinds

Navigation:

| Chord | Action |
|---|---|
| `j` / `↓` | select next |
| `k` / `↑` | select previous |
| `enter` | confirm / open |
| `esc` | back |
| `?` | help (dispatched, no on-screen handler yet — reserved for a help overlay) |
| `q` | quit |

Operator chords (vim-style; 500 ms chord timeout):

| Chord | Action | Primary precondition mirrored from the server |
|---|---|---|
| `g r` | run task | owning phase is `executing` |
| `g v` | review task | task is `in_review` |
| `g f` | fix task | task is `fixing` |
| `g i` | integrate phase | phase is `executing`/`integrating` AND all tasks `ready_to_merge`/`merged` |
| `g a` | audit phase | phase is `auditing` |
| `g c` | complete plan | every phase is `completed` |
| `g R` | release plan | `latestCompletionAudit.outcome === 'pass'` |

Every operator chord opens a confirm modal. Answer `y` or `enter` to fire the POST,
`n` or `esc` to cancel. If the server returns a 4xx the error renders inline in the
modal and the operator can retry or cancel. Chords that would 409 are dimmed in the
footer so unavailable actions are visually obvious before you try them.

Full binding table lives in [`src/lib/keybinds.ts`](./src/lib/keybinds.ts); gate
predicates in [`src/lib/state-machines.ts`](./src/lib/state-machines.ts).

## Operator flows

1. **Watch a plan to completion.** Start from the plans list, `enter` into the plan,
   leave the event tail running. Statuses update as the worker emits events.
2. **Drive a stuck task through review.** Select the task with `j`/`k`, `g r` to
   run, wait for `in_review`, `g v` to review. If the reviewer requests changes,
   `g f` to kick a fix cycle.
3. **Integrate + audit a phase.** From a phase whose tasks are all `ready_to_merge`,
   `g i` to integrate, wait for `auditing`, `g a` to audit.
4. **Complete + release.** Once every phase is `completed`, `g c` runs the completion
   audit. When the audit passes, `g R` publishes the PR summary + evidence bundle.
5. **Inspect release artifacts.** From plan-detail, `enter` on the "Release ▸" row
   (only shown when a completion audit exists) opens the release screen with the
   audit outcome, summary, findings, and artifact id list.

## Server-side gating

Client gates disable chords; the server is still authoritative. Deeper server-side
checks (e.g. the latest review report's outcome for `g f`, the merge_run state for
`g a`) aren't mirrored client-side — if one of them rejects, the 409 surfaces as an
inline error in the confirm modal and the operator can cancel and re-check.

## Troubleshooting

- **"loading plans…" forever.** The API isn't reachable at `PM_GO_API_BASE_URL`. Check
  `pnpm start:api` logs; verify `curl http://localhost:3001/plans` returns JSON.
- **Event tail silent.** The plan has no `workflow_events` yet (newly-created plans
  emit on first status transition). Trigger any POST chord or run
  `pnpm smoke:phase5` to populate.
- **Terminal looks garbled after a crash.** Ink normally restores terminal state on
  clean exit; if a crash leaves the terminal in raw mode, `reset` (or `stty sane`)
  restores it.

## Architecture

See [`docs/phases/phase6.md`](../../docs/phases/phase6.md) for the Phase 6 architecture
overview and how the TUI fits into the broader pm-go runtime.
