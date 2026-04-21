# `@pm-go/tui`

Terminal operator dashboard for pm-go, built on [Ink](https://github.com/vadimdemedes/ink).

```sh
pnpm tui
```

Connects to the Hono control-plane API (default `http://localhost:3001`, overridable
via `PM_GO_API_BASE_URL`). Monitors plans/phases/tasks/artifacts and drives the
Phase 5 operator actions. Worker 2 ships the runtime + data layer; operator controls
and filled screens arrive in Worker 3.
