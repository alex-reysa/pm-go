import { QueryClient } from "@tanstack/react-query";

/**
 * Shared `QueryClient` factory. Short `staleTime` so SSE-triggered
 * invalidations re-fetch immediately; modest `gcTime` so the back
 * button on a large plan returns from cache without hitting the
 * server. Retries disabled — 404/409 branches are UI affordances,
 * not transient failures worth re-issuing.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1_000,
        gcTime: 30_000,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}
