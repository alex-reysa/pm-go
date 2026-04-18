import type { SpecToPlanWorkflowInput } from "@pm-go/contracts";

// The Phase 2 contract change moves SpecToPlanWorkflowInput from inline
// SpecDocument + RepoSnapshot objects to bare UUID references. Re-wiring
// the workflow to call loadSpecDocument / loadRepoSnapshot / generatePlan
// lands in the API+Smoke lane. Foundation lane keeps the Phase 1b smoke
// compile-clean by passing the id through unchanged.
export async function SpecToPlanWorkflow(
  input: SpecToPlanWorkflowInput,
): Promise<{ persistedSpecDocumentId: string }> {
  return { persistedSpecDocumentId: input.specDocumentId };
}
