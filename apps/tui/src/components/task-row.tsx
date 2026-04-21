import { Box, Text } from "ink";
import React from "react";

import type { Task } from "@pm-go/contracts";

import { StatusBadge } from "./status-badge.js";

/**
 * Task row with cursor chevron. Renders under a phase card and takes
 * a minimum of one terminal line so long plans stay scannable. Slug
 * is fixed-width for alignment; title truncates.
 *
 * `selected` is controlled by the parent screen — the flat cursor
 * over all tasks lives in `plan-detail.tsx`.
 */
type TaskLike = Pick<
  Task,
  "id" | "slug" | "title" | "status" | "riskLevel"
>;

export function TaskRow(props: {
  task: TaskLike;
  selected: boolean;
}): React.ReactElement {
  const { task, selected } = props;
  return (
    <Box>
      {selected ? (
        <Text color="cyan">{"  ▶ "}</Text>
      ) : (
        <Text>{"    "}</Text>
      )}
      <Box width={18}>
        <Text dimColor>{truncate(task.slug, 16)}</Text>
      </Box>
      <Box width={32}>
        <Text>{truncate(task.title, 30)}</Text>
      </Box>
      <Box width={10}>
        <Text color={riskColor(task.riskLevel)}>{task.riskLevel}</Text>
      </Box>
      <StatusBadge status={task.status} />
    </Box>
  );
}

function riskColor(level: Task["riskLevel"]): "red" | "yellow" | "gray" {
  switch (level) {
    case "high":
      return "red";
    case "medium":
      return "yellow";
    case "low":
      return "gray";
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
