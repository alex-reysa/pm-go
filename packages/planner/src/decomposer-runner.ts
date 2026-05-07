import {
  auditMilestoneManifest,
  validateMilestoneManifest,
  type AgentRun,
  type MilestoneManifest,
  type MilestoneManifestAuditIssue,
  type RepoSnapshot,
  type SpecDocument,
} from "@pm-go/contracts";
import type { DecomposerRunner } from "@pm-go/executor-claude";

import { loadPrompt } from "./prompts.js";

export interface RunDecomposerInput {
  specDocument: SpecDocument;
  repoSnapshot: RepoSnapshot;
  /** User / operator that kicked off the decomposer run. Recorded alongside the AgentRun metadata by callers. */
  requestedBy: string;
  /** The executor-side runner that actually talks to the Claude Agent SDK (or a stub during tests). */
  runner: DecomposerRunner;
  /** Claude model id. Defaults to `"claude-opus-4-7"` to match the planner. */
  model?: string;
  /** Hard USD budget cap. Defaults to 0.50 — same envelope as the planner. */
  budgetUsdCap?: number;
  /** Hard turn cap. Defaults to 30. */
  maxTurnsCap?: number;
}

export interface RunDecomposerResult {
  manifest: MilestoneManifest;
  agentRun: AgentRun;
}

/**
 * Thrown when the manifest returned by the runner fails either the
 * structural `MilestoneManifestSchema` check or the cross-element audit
 * (id uniqueness / topological order). Carries the audit issues so
 * callers can surface them to operators or persist them as
 * `error_reason` on the `spec_decompositions` row.
 */
export class MilestoneManifestValidationError extends Error {
  readonly issues: ReadonlyArray<string>;

  constructor(message: string, issues: ReadonlyArray<string>) {
    super(message);
    this.name = "MilestoneManifestValidationError";
    this.issues = issues;
  }
}

/**
 * Orchestrates a single decomposer run:
 *
 * 1. Loads the `decomposer@1` system prompt from disk.
 * 2. Invokes the injected `DecomposerRunner` (stub in tests, Claude
 *    Agent SDK in production).
 * 3. Validates the returned `MilestoneManifest` structurally via
 *    `validateMilestoneManifest`, then runs `auditMilestoneManifest`
 *    for cross-element rules (unique ids, topological order, no
 *    cycles, no self-references).
 * 4. Asserts the manifest's `specDocumentId` / `repoSnapshotId` match
 *    the input — the prompt instructs the model to echo them, but a
 *    drifted manifest would silently bind a milestone plan to the
 *    wrong spec, so the runner enforces it.
 *
 * Throws {@link MilestoneManifestValidationError} on any failure.
 * Pure with respect to filesystem state — only the prompt file is read.
 */
export async function runDecomposer(
  input: RunDecomposerInput,
): Promise<RunDecomposerResult> {
  const systemPrompt = loadPrompt("decomposer", 1);

  const model = input.model ?? "claude-opus-4-7";
  const budgetUsdCap = input.budgetUsdCap ?? 0.5;
  const maxTurnsCap = input.maxTurnsCap ?? 30;

  const result = await input.runner.run({
    specDocument: input.specDocument,
    repoSnapshot: input.repoSnapshot,
    systemPrompt,
    promptVersion: "decomposer@1",
    model,
    budgetUsdCap,
    maxTurnsCap,
    cwd: input.repoSnapshot.repoRoot,
  });

  if (!validateMilestoneManifest(result.manifest)) {
    const issues = diagnoseManifestShape(result.manifest);
    const preview =
      issues.length > 0 ? `: ${issues.slice(0, 5).join("; ")}` : "";
    throw new MilestoneManifestValidationError(
      `runDecomposer: returned manifest failed MilestoneManifestSchema validation${preview}`,
      issues,
    );
  }

  const auditIssues: MilestoneManifestAuditIssue[] = auditMilestoneManifest(
    result.manifest,
  );
  if (auditIssues.length > 0) {
    const issues = auditIssues.map(
      (issue) => `${issue.code} at ${issue.path}: ${issue.message}`,
    );
    throw new MilestoneManifestValidationError(
      `runDecomposer: manifest failed audit: ${issues.slice(0, 5).join("; ")}`,
      issues,
    );
  }

  if (result.manifest.specDocumentId !== input.specDocument.id) {
    throw new MilestoneManifestValidationError(
      "runDecomposer: manifest.specDocumentId does not match input.specDocument.id",
      [
        `expected ${input.specDocument.id}, got ${result.manifest.specDocumentId}`,
      ],
    );
  }
  if (result.manifest.repoSnapshotId !== input.repoSnapshot.id) {
    throw new MilestoneManifestValidationError(
      "runDecomposer: manifest.repoSnapshotId does not match input.repoSnapshot.id",
      [
        `expected ${input.repoSnapshot.id}, got ${result.manifest.repoSnapshotId}`,
      ],
    );
  }

  return { manifest: result.manifest, agentRun: result.agentRun };
}

function diagnoseManifestShape(candidate: unknown): string[] {
  const issues: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    issues.push(
      `<root>: expected object, got ${candidate === null ? "null" : typeof candidate}`,
    );
    return issues;
  }
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.specDocumentId !== "string") issues.push("specDocumentId: missing or non-string");
  if (typeof obj.repoSnapshotId !== "string") issues.push("repoSnapshotId: missing or non-string");
  if (!Array.isArray(obj.milestones)) issues.push("milestones: missing or not an array");
  if (!Array.isArray(obj.deferredScope)) issues.push("deferredScope: missing or not an array");
  return issues;
}
