import React, { createContext, useContext } from "react";

import type { ApiClient } from "./api.js";
import type { TuiConfig } from "./config.js";

/**
 * TUI-wide runtime handles. The `App` provider passes these; hooks
 * read them. Bundling the api client + config into one context keeps
 * the hook signatures lean (no prop drilling) without pulling in a
 * state-management library for values that never change at runtime.
 *
 * `fetchImpl` is optional so tests can stub the SSE transport without
 * mutating `globalThis.fetch`. Production always falls back to the
 * runtime's global fetch (Node 22+).
 */
export interface TuiRuntime {
  api: ApiClient;
  config: TuiConfig;
  fetchImpl?: typeof fetch;
}

const TuiRuntimeContext = createContext<TuiRuntime | null>(null);

export function TuiRuntimeProvider(props: {
  runtime: TuiRuntime;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <TuiRuntimeContext.Provider value={props.runtime}>
      {props.children}
    </TuiRuntimeContext.Provider>
  );
}

export function useTuiRuntime(): TuiRuntime {
  const rt = useContext(TuiRuntimeContext);
  if (rt === null) {
    throw new Error(
      "useTuiRuntime: no TuiRuntimeProvider above in the tree — the app shell wraps all screens in one",
    );
  }
  return rt;
}
