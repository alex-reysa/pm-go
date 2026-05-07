import { describe, it, expect } from "vitest";
import type { AgentToolCall, SpecDocument, RepoSnapshot } from "@pm-go/contracts";
import type {
  AgentToolCallsRow,
  SpecDocumentRow,
  RepoSnapshotRow,
} from "@pm-go/db";

// Directional subtype checks: any row returned by the db should be
// assignable to the authoritative contract interface. Fails to
// type-check if the Drizzle schema drifts from the contracts.
type _SpecCheck = SpecDocumentRow extends SpecDocument ? true : never;
const _specOk: _SpecCheck = true;
void _specOk;

// `RepoSnapshot.repoUrl` is optional (`repoUrl?: string`); Drizzle models
// a nullable column as `string | null`. Map `null -> undefined` conceptually
// at the boundary; we assert structural compatibility for the non-null case.
type RepoRowNoNulls = Omit<RepoSnapshotRow, "repoUrl"> & { repoUrl?: string };
type _RepoCheck = RepoRowNoNulls extends RepoSnapshot ? true : never;
const _repoOk: _RepoCheck = true;
void _repoOk;

type AgentToolCallRowNoNulls = Omit<
  AgentToolCallsRow,
  | "sequence"
  | "summarizedOutput"
  | "completedAt"
  | "errorReason"
  | "specDocumentId"
  | "repoSnapshotId"
  | "planId"
  | "phaseId"
  | "taskId"
> & {
  sequence?: number;
  summarizedOutput?: Record<string, unknown>;
  completedAt?: string;
  errorReason?: string;
  specDocumentId?: string;
  repoSnapshotId?: string;
  planId?: string;
  phaseId?: string;
  taskId?: string;
};
type _AgentToolCallCheck =
  AgentToolCallRowNoNulls extends AgentToolCall ? true : never;
const _agentToolCallOk: _AgentToolCallCheck = true;
void _agentToolCallOk;

describe("@pm-go/db schema shape", () => {
  it("aligns with contract types", () => {
    // The real assertion is the type-level check above; this keeps vitest
    // happy by recording at least one passing expectation.
    expect(_specOk).toBe(true);
    expect(_repoOk).toBe(true);
    expect(_agentToolCallOk).toBe(true);
  });
});
