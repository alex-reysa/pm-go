import { Box, Text, useApp } from "ink";
import React, { useCallback } from "react";

import type { Task, UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { Spinner } from "../components/spinner.js";
import { StatusBadge } from "../components/status-badge.js";
import { usePlan, useAgentRuns } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";
import {
  canFixTask,
  canReviewTask,
  canRunTask,
} from "../lib/state-machines.js";
import type { PendingAction, Route } from "../types.js";

/**
 * Fullscreen task drawer. Renders the contract's `Task` fields an
 * operator cares about mid-execution (file scope, acceptance
 * criteria, budget, branch) plus the task's agent-run log. Operator
 * chords (`g r` / `g v` / `g f`) fire against this task; everything
 * else (esc/q/j/k) is screen-local.
 */
export function TaskDrawerScreen(props: {
  planId: UUID;
  taskId: UUID;
  onBack: () => void;
  onRequestAction: (action: PendingAction) => void;
  onNavigate: (route: Route) => void;
}): React.ReactElement {
  const { data: planDetail, isLoading, error } = usePlan(props.planId);
  const { data: agentRuns } = useAgentRuns(props.taskId);
  const { exit } = useApp();

  const task = planDetail?.plan.tasks.find((t) => t.id === props.taskId) ?? null;
  const phase =
    task !== null
      ? planDetail?.plan.phases.find((p) => p.id === task.phaseId) ?? null
      : null;

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "cancel":
          props.onBack();
          return;
        case "quit":
          exit();
          return;
        case "run-task":
          if (task !== null && phase !== null && canRunTask(phase, task).ok) {
            props.onRequestAction({
              kind: "run-task",
              taskId: task.id,
              label: `Run task '${task.slug}' in phase '${phase.title}'?`,
            });
          }
          return;
        case "review-task":
          if (task !== null && canReviewTask(task).ok) {
            props.onRequestAction({
              kind: "review-task",
              taskId: task.id,
              label: `Kick off review for task '${task.slug}'?`,
            });
          }
          return;
        case "fix-task":
          if (task !== null && canFixTask(task).ok) {
            props.onRequestAction({
              kind: "fix-task",
              taskId: task.id,
              label: `Start fix cycle on task '${task.slug}'?`,
            });
          }
          return;
        default:
          return;
      }
    },
    [exit, phase, props, task],
  );

  useKeybinds(dispatch);

  if (isLoading && planDetail === undefined) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner label="loading task…" />
      </Box>
    );
  }
  if (error !== null && planDetail === undefined) {
    return (
      <Box paddingX={1}>
        <ErrorBanner error={error} />
      </Box>
    );
  }
  if (task === null) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>task not found on plan — press esc</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{`${task.slug}  `}</Text>
        <StatusBadge status={task.status} />
      </Box>
      <Box>
        <Text>{task.title}</Text>
      </Box>
      {task.summary.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{task.summary}</Text>
        </Box>
      )}

      <Section title="File scope">
        {renderFileScope(task)}
      </Section>

      <Section title="Acceptance criteria">
        {task.acceptanceCriteria.length === 0 ? (
          <Text dimColor>(none)</Text>
        ) : (
          task.acceptanceCriteria.map((c) => (
            <Box key={c.id}>
              <Text>{c.required ? "• " : "◦ "}</Text>
              <Text>{c.description}</Text>
            </Box>
          ))
        )}
      </Section>

      <Section title="Budget">
        <Box>
          <Text dimColor>{`${task.budget.maxWallClockMinutes}m wall-clock`}</Text>
          {task.budget.maxModelCostUsd !== undefined && (
            <Text dimColor>{`  $${task.budget.maxModelCostUsd} cap`}</Text>
          )}
          {task.budget.maxPromptTokens !== undefined && (
            <Text dimColor>{`  ${task.budget.maxPromptTokens} prompt tokens`}</Text>
          )}
        </Box>
      </Section>

      <Section title="Branch">
        <Text>{task.branchName ?? "(not yet leased)"}</Text>
      </Section>

      <Section title={`Agent runs (${agentRuns?.length ?? 0})`}>
        {agentRuns === undefined ? (
          <Spinner />
        ) : agentRuns.length === 0 ? (
          <Text dimColor>(no runs yet)</Text>
        ) : (
          agentRuns.slice(0, 8).map((r) => (
            <Box key={r.id}>
              <Box width={14}>
                <Text dimColor>{r.role}</Text>
              </Box>
              <Box width={14}>
                <Text>{r.status}</Text>
              </Box>
              <Text dimColor>{r.model}</Text>
            </Box>
          ))
        )}
      </Section>
    </Box>
  );
}

function Section(props: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold dimColor>
        {props.title}
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {props.children}
      </Box>
    </Box>
  );
}

function renderFileScope(task: Task): React.ReactElement {
  const inc = task.fileScope.includes ?? [];
  const exc = task.fileScope.excludes ?? [];
  return (
    <Box flexDirection="column">
      {inc.length > 0 && (
        <Box>
          <Text dimColor>includes: </Text>
          <Text>{inc.join(", ")}</Text>
        </Box>
      )}
      {exc.length > 0 && (
        <Box>
          <Text dimColor>excludes: </Text>
          <Text>{exc.join(", ")}</Text>
        </Box>
      )}
      {inc.length === 0 && exc.length === 0 && <Text dimColor>(unscoped)</Text>}
    </Box>
  );
}
