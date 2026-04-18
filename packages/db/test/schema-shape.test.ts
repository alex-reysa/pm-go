import { describe, it, expect } from "vitest";
import type { SpecDocument, RepoSnapshot } from "@pm-go/contracts";
import type { SpecDocumentRow, RepoSnapshotRow } from "@pm-go/db";

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

describe("@pm-go/db schema shape", () => {
  it("aligns with contract types", () => {
    // The real assertion is the type-level check above; this keeps vitest
    // happy by recording at least one passing expectation.
    expect(_specOk).toBe(true);
    expect(_repoOk).toBe(true);
  });
});
