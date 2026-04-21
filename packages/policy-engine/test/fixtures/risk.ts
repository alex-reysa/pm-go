import type { Risk } from "@pm-go/contracts";

export function buildRisk(overrides: Partial<Risk> = {}): Risk {
  const base: Risk = {
    id: "risk-1",
    level: "medium",
    title: "Sample risk",
    description: "fixture risk for approval-gate tests",
    mitigation: "N/A",
    humanApprovalRequired: false,
  };
  return { ...base, ...overrides };
}
