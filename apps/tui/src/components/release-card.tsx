import { Box, Text } from "ink";
import React from "react";

import type { CompletionAuditReport } from "@pm-go/contracts";

/**
 * Plan-detail "Release ▸" row. Only rendered when the plan has run
 * completion audit (i.e. `latestCompletionAudit !== null`). Visually
 * distinct from phase cards so the operator's eye catches the
 * release-readiness state without scanning phase statuses.
 */
export function ReleaseCard(props: {
  audit: CompletionAuditReport;
  selected: boolean;
}): React.ReactElement {
  const { audit, selected } = props;
  const passed = audit.outcome === "pass";
  return (
    <Box>
      {selected ? (
        <Text color="cyan">{"▶ "}</Text>
      ) : (
        <Text>{"  "}</Text>
      )}
      <Box width={10}>
        <Text bold color={passed ? "green" : "red"}>
          Release
        </Text>
      </Box>
      <Box width={20}>
        <Text color={passed ? "green" : "red"}>{`audit: ${audit.outcome}`}</Text>
      </Box>
      <Text dimColor>
        {passed
          ? "ready for release — press enter to view"
          : "audit blocked — re-run complete before release"}
      </Text>
    </Box>
  );
}
