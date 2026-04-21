import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { Box } from "ink";
import React, { useState } from "react";

import type { UUID } from "@pm-go/contracts";

import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { TuiRuntimeProvider, type TuiRuntime } from "./lib/context.js";
import { PlansListScreen } from "./screens/plans-list.js";
import { PlanDetailScreen } from "./screens/plan-detail.js";
import type { Route } from "./types.js";

/**
 * Top-level app shell. Owns the route state + bounds the full-screen
 * layout. Screens self-register their keybinds via `useKeybinds`
 * (`plans-list` handles j/k/enter; `plan-detail` handles esc + the
 * Worker 3 operator chords).
 */
export function App(props: {
  runtime: TuiRuntime;
  queryClient: QueryClient;
  /** Seed route — defaults to plans list. Exposed for tests. */
  initialRoute?: Route;
}): React.ReactElement {
  const [route, setRoute] = useState<Route>(
    props.initialRoute ?? { name: "plans" },
  );

  return (
    <QueryClientProvider client={props.queryClient}>
      <TuiRuntimeProvider runtime={props.runtime}>
        <Box flexDirection="column" height="100%">
          <Header apiBaseUrl={props.runtime.config.apiBaseUrl} route={route} />
          <Box flexDirection="column" flexGrow={1}>
            {route.name === "plans" ? (
              <PlansListScreen onSelect={(planId: UUID) => setRoute({ name: "plan", planId })} />
            ) : (
              <PlanDetailScreen
                planId={route.planId}
                onBack={() => setRoute({ name: "plans" })}
              />
            )}
          </Box>
          <Footer />
        </Box>
      </TuiRuntimeProvider>
    </QueryClientProvider>
  );
}
