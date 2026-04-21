/**
 * TUI runtime configuration. Values come from environment variables so
 * the dashboard can point at dev, staging, or a temp-clone smoke stack
 * without code changes.
 */
export interface TuiConfig {
  /** Hono control-plane base URL. Trailing slash stripped. */
  apiBaseUrl: string;
  /** Polling interval (ms) for list queries when SSE hasn't invalidated them. */
  listRefreshIntervalMs: number;
  /** Max backoff (ms) when the SSE stream reconnects after a drop. */
  eventStreamMaxBackoffMs: number;
}

const DEFAULTS = {
  apiBaseUrl: "http://localhost:3001",
  listRefreshIntervalMs: 5_000,
  eventStreamMaxBackoffMs: 5_000,
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TuiConfig {
  const raw = env["PM_GO_API_BASE_URL"]?.trim();
  const apiBaseUrl =
    raw !== undefined && raw.length > 0
      ? raw.replace(/\/+$/, "")
      : DEFAULTS.apiBaseUrl;
  return {
    apiBaseUrl,
    listRefreshIntervalMs: DEFAULTS.listRefreshIntervalMs,
    eventStreamMaxBackoffMs: DEFAULTS.eventStreamMaxBackoffMs,
  };
}
