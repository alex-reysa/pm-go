import { Box, Text, useApp } from "ink";
import React, { useCallback, useMemo, useState } from "react";

import type { Phase, Task, UUID } from "@pm-go/contracts";

import { ErrorBanner } from "../components/error-banner.js";
import { PhaseCard } from "../components/phase-card.js";
import { ReleaseCard } from "../components/release-card.js";
import { Spinner } from "../components/spinner.js";
import { StatusBadge } from "../components/status-badge.js";
import { TaskRow } from "../components/task-row.js";
import type { PlanDetail } from "../lib/api.js";
import { usePlan } from "../lib/hooks.js";
import { useKeybinds, type TuiAction } from "../lib/keybinds.js";
import {
  canAuditPhase,
  canCompletePlan,
  canFixTask,
  canIntegratePhase,
  canReleasePlan,
  canReviewTask,
  canRunTask,
} from "../lib/state-machines.js";
import type { PendingAction, PlanSelection, Route } from "../types.js";

import { EventsTail } from "./events-tail.js";

/**
 * Plan-detail screen. Flat cursor over all tasks (optionally
 * preceded by a "Release" row when the plan has a completion audit),
 * grouped visually by phase. Enter on a task navigates to the
 * fullscreen drawer; enter on the release row navigates to the
 * release screen. Operator chords dispatch a `PendingAction` to the
 * app shell, which renders a confirm modal.
 */
export function PlanDetailScreen(props: {
  planId: UUID;
  onBack: () => void;
  onNavigate: (route: Route) => void;
  onRequestAction: (action: PendingAction) => void;
  /** Exposes disabled chord kinds so the footer can dim them. */
  onDisabledKindsChange?: (kinds: ReadonlyArray<TuiAction["kind"]>) => void;
  /**
   * Selection to restore on mount (persisted by the app shell across
   * confirm-modal unmounts). `null` starts at the first selectable
   * row. When items change so the selection no longer matches, the
   * cursor falls back to the first row and the new selection is
   * reported via `onSelectionChange`.
   */
  initialSelection?: PlanSelection | null;
  onSelectionChange?: (planId: UUID, selection: PlanSelection | null) => void;
}): React.ReactElement {
  const { planId, onBack, onNavigate, onRequestAction, onSelectionChange } = props;
  const { data, isLoading, error } = usePlan(planId);
  const { exit } = useApp();

  const items = useMemo(() => buildSelectableItems(data ?? null), [data]);
  const [cursor, setCursor] = useState(0);

  // When items load (or change), align the cursor with the persisted
  // `initialSelection` from the app shell. Runs once per items-id
  // turnover — not on every render — via a stable deps array.
  React.useEffect(() => {
    if (items.length === 0) return;
    const initialSelection = props.initialSelection ?? null;
    const idx = findSelectionIndex(items, initialSelection);
    setCursor(idx >= 0 ? idx : 0);
    // `initialSelection` purposely omitted — we only want to restore on
    // the first items load, not on every re-mount with the same data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const clampedCursor = items.length === 0 ? 0 : Math.min(cursor, items.length - 1);
  const currentItem = items[clampedCursor] ?? null;

  // Report cursor movements up so App can restore them after a modal.
  // Guard against redundant emits with a ref so a stable selection
  // object ref (items memoized; currentItem shares task/phase refs)
  // doesn't trigger a re-render cascade when the effect re-runs under
  // an unstable onSelectionChange callback identity.
  const lastReportedRef = React.useRef<PlanSelection | null>(null);
  React.useEffect(() => {
    if (onSelectionChange === undefined) return;
    const next =
      currentItem !== null ? itemToSelection(currentItem) : null;
    if (selectionsEqual(lastReportedRef.current, next)) return;
    lastReportedRef.current = next;
    onSelectionChange(planId, next);
  }, [currentItem, onSelectionChange, planId]);

  const { selectedTask, selectedPhase } =
    currentItem?.kind === "task"
      ? { selectedTask: currentItem.task, selectedPhase: currentItem.phase }
      : { selectedTask: null, selectedPhase: null };

  // Memoized so the effect below sees a stable array reference between
  // unrelated renders — otherwise the disabled-kinds callback would
  // fire on every keypress and trigger an App re-render loop.
  const disabledKinds = useMemo(
    () => computeDisabledKinds(data ?? null, selectedTask, selectedPhase),
    [data, selectedTask, selectedPhase],
  );

  const { onDisabledKindsChange } = props;
  React.useEffect(() => {
    onDisabledKindsChange?.(disabledKinds);
  }, [disabledKinds, onDisabledKindsChange]);

  const dispatch = useCallback(
    (action: TuiAction) => {
      switch (action.kind) {
        case "select-next":
          if (items.length > 0) setCursor((c) => (c + 1) % items.length);
          return;
        case "select-prev":
          if (items.length > 0)
            setCursor((c) => (c - 1 + items.length) % items.length);
          return;
        case "confirm": {
          if (currentItem === null) return;
          if (currentItem.kind === "release") {
            onNavigate({ name: "release", planId });
          } else {
            onNavigate({
              name: "task",
              planId,
              taskId: currentItem.task.id,
            });
          }
          return;
        }
        case "cancel":
          onBack();
          return;
        case "quit":
          exit();
          return;
        case "run-task":
          if (selectedTask !== null && selectedPhase !== null && canRunTask(selectedPhase, selectedTask).ok) {
            onRequestAction({
              kind: "run-task",
              taskId: selectedTask.id,
              label: `Run task '${selectedTask.slug}' in phase '${selectedPhase.title}'?`,
            });
          }
          return;
        case "review-task":
          if (selectedTask !== null && canReviewTask(selectedTask).ok) {
            onRequestAction({
              kind: "review-task",
              taskId: selectedTask.id,
              label: `Kick off review for task '${selectedTask.slug}'?`,
            });
          }
          return;
        case "fix-task":
          if (selectedTask !== null && canFixTask(selectedTask).ok) {
            onRequestAction({
              kind: "fix-task",
              taskId: selectedTask.id,
              label: `Start fix cycle on task '${selectedTask.slug}'?`,
            });
          }
          return;
        case "integrate-phase": {
          if (selectedPhase === null || data === undefined) return;
          const phaseTasks = data.plan.tasks.filter(
            (t) => t.phaseId === selectedPhase.id,
          );
          if (!canIntegratePhase(selectedPhase, phaseTasks).ok) return;
          onRequestAction({
            kind: "integrate-phase",
            phaseId: selectedPhase.id,
            label: `Integrate phase '${selectedPhase.title}' (merges ${phaseTasks.length} task${phaseTasks.length === 1 ? "" : "s"} to main)?`,
          });
          return;
        }
        case "audit-phase":
          if (selectedPhase !== null && canAuditPhase(selectedPhase).ok) {
            onRequestAction({
              kind: "audit-phase",
              phaseId: selectedPhase.id,
              label: `Audit phase '${selectedPhase.title}' against the integrated branch?`,
            });
          }
          return;
        case "complete-plan":
          if (data !== undefined && canCompletePlan(data.plan).ok) {
            onRequestAction({
              kind: "complete-plan",
              planId,
              label: `Mark plan '${data.plan.title}' complete? (runs completion audit)`,
            });
          }
          return;
        case "release-plan":
          if (data !== undefined && canReleasePlan(data).ok) {
            onRequestAction({
              kind: "release-plan",
              planId,
              label: `RELEASE plan '${data.plan.title}'? Publishes the PR summary + evidence bundle.`,
            });
          }
          return;
        default:
          return;
      }
    },
    [
      currentItem,
      data,
      exit,
      items.length,
      onBack,
      onNavigate,
      onRequestAction,
      planId,
      selectedPhase,
      selectedTask,
    ],
  );

  useKeybinds(dispatch);

  if (isLoading && data === undefined) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner label="loading plan…" />
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

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" paddingX={1}>
        <Box>
          <Text bold>{data.plan.title}</Text>
        </Box>
        <Box>
          <Text dimColor>{`${props.planId.slice(0, 8)}  `}</Text>
          <StatusBadge status={data.plan.status} />
          <Text dimColor>{`  phases=${data.plan.phases.length}  tasks=${data.plan.tasks.length}`}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginTop={1} paddingX={1}>
        {items.length === 0 ? (
          <Text dimColor>plan has no phases yet</Text>
        ) : (
          renderItems(data, items, clampedCursor)
        )}
      </Box>

      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle="single"
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderTop
      >
        <EventsTail planId={props.planId} />
      </Box>
    </Box>
  );
}

type SelectableItem =
  | { kind: "release" }
  | { kind: "task"; task: Task; phase: Phase };

function itemToSelection(item: SelectableItem): PlanSelection {
  return item.kind === "release"
    ? { kind: "release" }
    : { kind: "task", taskId: item.task.id };
}

function selectionsEqual(
  a: PlanSelection | null,
  b: PlanSelection | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "release") return true;
  return a.taskId === (b as { kind: "task"; taskId: string }).taskId;
}

function findSelectionIndex(
  items: SelectableItem[],
  selection: PlanSelection | null,
): number {
  if (selection === null) return 0;
  if (selection.kind === "release") {
    return items.findIndex((i) => i.kind === "release");
  }
  return items.findIndex(
    (i) => i.kind === "task" && i.task.id === selection.taskId,
  );
}

function buildSelectableItems(data: PlanDetail | null): SelectableItem[] {
  if (data === null) return [];
  const items: SelectableItem[] = [];
  if (data.latestCompletionAudit !== null) items.push({ kind: "release" });
  const phases = [...data.plan.phases].sort((a, b) => a.index - b.index);
  for (const phase of phases) {
    const tasks = data.plan.tasks.filter((t) => t.phaseId === phase.id);
    for (const task of tasks) items.push({ kind: "task", task, phase });
  }
  return items;
}

function renderItems(
  data: PlanDetail,
  items: SelectableItem[],
  cursor: number,
): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let lastPhaseId: UUID | null = null;

  items.forEach((item, i) => {
    const selected = i === cursor;
    if (item.kind === "release") {
      nodes.push(
        <Box key="release-row" marginBottom={1}>
          <ReleaseCard
            audit={data.latestCompletionAudit!}
            selected={selected}
          />
        </Box>,
      );
      return;
    }
    if (item.phase.id !== lastPhaseId) {
      const phaseTasks = data.plan.tasks.filter(
        (t) => t.phaseId === item.phase.id,
      );
      nodes.push(
        <Box key={`phase-${item.phase.id}`} marginTop={lastPhaseId === null ? 0 : 1}>
          <PhaseCard phase={item.phase} taskCount={phaseTasks.length} />
        </Box>,
      );
      lastPhaseId = item.phase.id;
    }
    nodes.push(
      <TaskRow key={`task-${item.task.id}`} task={item.task} selected={selected} />,
    );
  });

  return nodes;
}

function computeDisabledKinds(
  data: PlanDetail | null,
  selectedTask: Task | null,
  selectedPhase: Phase | null,
): ReadonlyArray<TuiAction["kind"]> {
  const disabled: TuiAction["kind"][] = [];
  if (data === null) return disabled;

  const tryGate = (kind: TuiAction["kind"], ok: boolean) => {
    if (!ok) disabled.push(kind);
  };

  const phaseTasks =
    selectedPhase !== null
      ? data.plan.tasks.filter((t) => t.phaseId === selectedPhase.id)
      : [];

  tryGate(
    "run-task",
    selectedTask !== null &&
      selectedPhase !== null &&
      canRunTask(selectedPhase, selectedTask).ok,
  );
  tryGate("review-task", selectedTask !== null && canReviewTask(selectedTask).ok);
  tryGate("fix-task", selectedTask !== null && canFixTask(selectedTask).ok);
  tryGate(
    "integrate-phase",
    selectedPhase !== null && canIntegratePhase(selectedPhase, phaseTasks).ok,
  );
  tryGate("audit-phase", selectedPhase !== null && canAuditPhase(selectedPhase).ok);
  tryGate("complete-plan", canCompletePlan(data.plan).ok);
  tryGate("release-plan", canReleasePlan(data).ok);
  return disabled;
}
