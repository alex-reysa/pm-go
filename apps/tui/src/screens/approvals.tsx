import { Box, Text, useApp } from "ink";
import React, { useCallback, useMemo, useState } from "react";

import type { ApprovalRequest, UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { Spinner } from "../components/spinner.js";
import { useApprovals } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";
import type { PendingAction } from "../types.js";

/**
 * Phase 7 — Approvals screen. Lists every `approval_requests` row for
 * the plan, with the latest pending row at the top. Operator
 * highlights one and presses Enter (or `g A`) to fire the approve
 * action through the standard confirm-modal pipeline.
 *
 * Read-only otherwise — no inline rejection / re-issuance UI in V1.
 * The TUI's only mutation here is `approveTask` / `approvePlan`; a
 * decided row (approved / rejected) renders dim and isn't selectable.
 */
export function ApprovalsScreen(props: {
  planId: UUID;
  onBack: () => void;
  onRequestAction: (action: PendingAction) => void;
}): React.ReactElement {
  const { planId, onBack, onRequestAction } = props;
  const { data, isLoading, error } = useApprovals(planId);
  const { exit } = useApp();

  const pendingApprovals = useMemo(
    () => (data ?? []).filter((a) => a.status === "pending"),
    [data],
  );
  const decidedApprovals = useMemo(
    () => (data ?? []).filter((a) => a.status !== "pending"),
    [data],
  );

  const [cursor, setCursor] = useState(0);
  const clampedCursor =
    pendingApprovals.length === 0
      ? 0
      : Math.min(cursor, pendingApprovals.length - 1);
  const selected = pendingApprovals[clampedCursor] ?? null;

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "select-next":
          if (pendingApprovals.length > 0) {
            setCursor((c) => (c + 1) % pendingApprovals.length);
          }
          return;
        case "select-prev":
          if (pendingApprovals.length > 0) {
            setCursor(
              (c) =>
                (c - 1 + pendingApprovals.length) % pendingApprovals.length,
            );
          }
          return;
        case "confirm":
        case "approve-task":
          if (selected !== null && selected.subject === "task" && selected.taskId) {
            onRequestAction({
              kind: "approve-task",
              taskId: selected.taskId,
              label: `Approve ${selected.riskBand}-risk task ${selected.taskId.slice(0, 8)}?`,
            });
          } else if (selected !== null && selected.subject === "plan") {
            onRequestAction({
              kind: "approve-plan",
              planId: selected.planId,
              label: `Approve ${selected.riskBand}-risk plan ${selected.planId.slice(0, 8)}?`,
            });
          }
          return;
        case "cancel":
          onBack();
          return;
        case "quit":
          exit();
          return;
        default:
          return;
      }
    },
    [exit, onBack, onRequestAction, pendingApprovals.length, selected],
  );

  useKeybinds(dispatch);

  if (isLoading && data === undefined) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner label="loading approvals…" />
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

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box>
        <Text bold>Approvals</Text>
        <Text dimColor>{`  plan ${planId.slice(0, 8)}`}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{`Pending (${pendingApprovals.length})`}</Text>
        {pendingApprovals.length === 0 ? (
          <Text dimColor>  (no pending approvals)</Text>
        ) : (
          pendingApprovals.map((a, i) => (
            <ApprovalRow key={a.id} approval={a} selected={i === clampedCursor} />
          ))
        )}
      </Box>

      {decidedApprovals.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{`Decided (${decidedApprovals.length})`}</Text>
          {decidedApprovals.slice(0, 10).map((a) => (
            <ApprovalRow key={a.id} approval={a} selected={false} />
          ))}
          {decidedApprovals.length > 10 && (
            <Text dimColor>{`  +${decidedApprovals.length - 10} more`}</Text>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {pendingApprovals.length > 0
            ? "j/k to move, enter or gA to approve, esc to back, q to quit"
            : "esc to back, q to quit"}
        </Text>
      </Box>
    </Box>
  );
}

function ApprovalRow(props: {
  approval: ApprovalRequest;
  selected: boolean;
}): React.ReactElement {
  const { approval, selected } = props;
  const subjectLabel =
    approval.subject === "task"
      ? `task ${(approval.taskId ?? "").slice(0, 8)}`
      : `plan ${approval.planId.slice(0, 8)}`;
  return (
    <Box>
      {selected ? <Text color="cyan">› </Text> : <Text>  </Text>}
      <Text dimColor={approval.status !== "pending"}>
        {`${approval.status.padEnd(9)} ${approval.riskBand.padEnd(13)} ${subjectLabel}  ${approval.requestedAt.slice(11, 19)}Z`}
      </Text>
    </Box>
  );
}
