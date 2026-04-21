import { Box, Text, useApp } from "ink";
import React, { useCallback } from "react";

import type { UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { Spinner } from "../components/spinner.js";
import { StatusBadge } from "../components/status-badge.js";
import { usePlan } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";
import { canReleasePlan } from "../lib/state-machines.js";
import type { PendingAction } from "../types.js";

/**
 * Release screen. Informational view plus a single gated action
 * (`g R` → confirm → POST /plans/:id/release). Everything rendered
 * here comes from `PlanDetail.latestCompletionAudit` + `artifactIds`,
 * both already loaded by `usePlan`.
 */
export function ReleaseScreen(props: {
  planId: UUID;
  onBack: () => void;
  onRequestAction: (action: PendingAction) => void;
}): React.ReactElement {
  const { data, isLoading, error } = usePlan(props.planId);
  const { exit } = useApp();

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "cancel":
          props.onBack();
          return;
        case "quit":
          exit();
          return;
        case "release-plan":
          if (data !== undefined && canReleasePlan(data).ok) {
            props.onRequestAction({
              kind: "release-plan",
              planId: props.planId,
              label: `RELEASE plan '${data.plan.title}'? Publishes the PR summary + evidence bundle.`,
            });
          }
          return;
        default:
          return;
      }
    },
    [data, exit, props],
  );

  useKeybinds(dispatch);

  if (isLoading && data === undefined) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner label="loading release state…" />
      </Box>
    );
  }
  if (error !== null && data === undefined) {
    return (
      <Box paddingX={1}>
        <ErrorBanner error={error} />
      </Box>
    );
  }
  if (data === undefined) return <Box />;

  const audit = data.latestCompletionAudit;
  const releaseGate = canReleasePlan(data);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{data.plan.title}</Text>
        <Text dimColor>{`  ${props.planId.slice(0, 8)}  `}</Text>
        <StatusBadge status={data.plan.status} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>
          Completion audit
        </Text>
        {audit === null ? (
          <Text dimColor>
            (no completion audit yet — run /plans/:id/complete first)
          </Text>
        ) : (
          <Box flexDirection="column" marginLeft={2}>
            <Box>
              <Text>Outcome: </Text>
              <Text
                bold
                color={
                  audit.outcome === "pass"
                    ? "green"
                    : audit.outcome === "changes_requested"
                      ? "yellow"
                      : "red"
                }
              >
                {audit.outcome}
              </Text>
            </Box>
            <Box>
              <Text dimColor>{`merge sha ${audit.auditedHeadSha.slice(0, 12)}`}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Acceptance criteria passed: </Text>
              <Text>{`${audit.summary.acceptanceCriteriaPassed.length}`}</Text>
            </Box>
            <Box>
              <Text dimColor>Acceptance criteria missing: </Text>
              {audit.summary.acceptanceCriteriaMissing.length > 0 ? (
                <Text color="red">
                  {audit.summary.acceptanceCriteriaMissing.length}
                </Text>
              ) : (
                <Text>0</Text>
              )}
            </Box>
            <Box>
              <Text dimColor>Open findings: </Text>
              {audit.summary.openFindingIds.length > 0 ? (
                <Text color="red">{audit.summary.openFindingIds.length}</Text>
              ) : (
                <Text>0</Text>
              )}
            </Box>
          </Box>
        )}
      </Box>

      {audit !== null && audit.findings.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>
            Findings
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            {audit.findings.slice(0, 10).map((f) => (
              <Box key={f.id}>
                <Text color={severityColor(f.severity)}>{f.severity}</Text>
                <Text>{`  ${f.title}`}</Text>
              </Box>
            ))}
            {audit.findings.length > 10 && (
              <Text dimColor>{`… and ${audit.findings.length - 10} more`}</Text>
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold dimColor>{`Artifacts (${data.artifactIds.length})`}</Text>
        <Box flexDirection="column" marginLeft={2}>
          {data.artifactIds.length === 0 ? (
            <Text dimColor>(no artifacts yet)</Text>
          ) : (
            data.artifactIds.map((id) => (
              <Text key={id} dimColor>
                {id}
              </Text>
            ))
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        {releaseGate.ok ? (
          <Text color="green">press gR to release</Text>
        ) : (
          <Text dimColor>{`release locked: ${releaseGate.reason}`}</Text>
        )}
      </Box>
    </Box>
  );
}

function severityColor(
  sev: string,
): "red" | "yellow" | "cyan" | "gray" {
  switch (sev) {
    case "critical":
    case "high":
      return "red";
    case "medium":
      return "yellow";
    case "low":
      return "cyan";
    default:
      return "gray";
  }
}
