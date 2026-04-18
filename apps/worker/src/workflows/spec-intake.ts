import { proxyActivities } from "@temporalio/workflow";
import type { SpecToPlanWorkflowInput } from "@pm-go/contracts";

interface SpecIntakeActivityInterface {
  persistSpecDocument(input: SpecToPlanWorkflowInput["specDocument"]): Promise<string>;
}

const { persistSpecDocument } = proxyActivities<SpecIntakeActivityInterface>({
  startToCloseTimeout: "30s",
});

export async function SpecToPlanWorkflow(
  input: SpecToPlanWorkflowInput,
): Promise<{ persistedSpecDocumentId: string }> {
  const persistedSpecDocumentId = await persistSpecDocument(input.specDocument);
  return { persistedSpecDocumentId };
}
