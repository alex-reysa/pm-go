#!/usr/bin/env node
import { render } from "ink";
import React from "react";

import { App } from "./app.js";
import { createApiClient } from "./lib/api.js";
import { loadConfig } from "./lib/config.js";
import { createQueryClient } from "./lib/query-client.js";

/**
 * CLI entrypoint. `exitOnCtrlC: true` keeps the operator's muscle
 * memory intact (Ink handles the cleanup on the way out). The
 * full-screen alt-buffer flag isn't exposed in Ink 5.2's public
 * options type; the dashboard renders inline, which is fine for MVP.
 */
function main(): void {
  const config = loadConfig();
  const api = createApiClient({ baseUrl: config.apiBaseUrl });
  const queryClient = createQueryClient();

  render(<App runtime={{ api, config }} queryClient={queryClient} />, {
    exitOnCtrlC: true,
  });
}

main();
