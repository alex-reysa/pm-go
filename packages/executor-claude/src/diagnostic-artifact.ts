/**
 * Diagnostic-artifact surface for runtime structured-output failures
 * (v0.8.2 Task 3.1, F6).
 *
 * Background: when the reviewer / phase-auditor / completion-auditor
 * runners receive a `structured_output` payload that fails our runtime
 * TypeBox validators, the only signal in the durable trail is the error
 * message — the raw payload is gone, so the next dogfood run rediscovers
 * the same failure shape blind. This module gives the runners a small,
 * sanitized sink they can fire before re-throwing, so operators can
 * inspect the malformed payload after the fact.
 *
 * Sanitization rules: NEVER ship API keys, full prompts, or environment
 * data through the diagnostic. The artifact carries enough context to
 * diff against the schema and that's all.
 */

import { randomUUID } from "node:crypto";

export type RunnerDiagnosticRole =
  | "reviewer"
  | "phase-auditor"
  | "completion-auditor";

export interface RunnerDiagnosticArtifact {
  id: string;
  role: RunnerDiagnosticRole;
  schemaRef: string;
  validationErrorSummary: string;
  /**
   * The raw `structured_output` payload from the SDK, sanitized below.
   * This is intentionally `unknown` — callers that persist it should
   * round-trip through `JSON.stringify` so a non-serializable payload
   * surfaces as a failure rather than silent data loss.
   */
  sanitizedStructuredOutput: unknown;
  sdkResultSubtype?: string;
  sessionId?: string;
  createdAt: string;
}

export type RunnerDiagnosticSink = (
  artifact: RunnerDiagnosticArtifact,
) => Promise<void> | void;

/**
 * Pure helper. Constructs a `RunnerDiagnosticArtifact` from the inputs
 * the runners already have at the moment validation fails. The output
 * is JSON-safe: any cycles or unserializable values in `rawPayload` are
 * stripped to an empty object so the sink receives a clean payload.
 */
export function buildSchemaValidationDiagnostic(input: {
  role: RunnerDiagnosticRole;
  schemaRef: string;
  validationErrorSummary: string;
  rawPayload: unknown;
  sdkResultSubtype?: string;
  sessionId?: string;
}): RunnerDiagnosticArtifact {
  const artifact: RunnerDiagnosticArtifact = {
    id: randomUUID(),
    role: input.role,
    schemaRef: input.schemaRef,
    validationErrorSummary: input.validationErrorSummary,
    sanitizedStructuredOutput: sanitizePayload(input.rawPayload),
    createdAt: new Date().toISOString(),
  };
  if (input.sdkResultSubtype !== undefined) {
    artifact.sdkResultSubtype = input.sdkResultSubtype;
  }
  if (input.sessionId !== undefined) {
    artifact.sessionId = input.sessionId;
  }
  return artifact;
}

/**
 * Strip well-known sensitive keys from a payload tree. Anthropic SDK
 * structured outputs should never carry these, but defense-in-depth: a
 * malformed payload that happened to include an upstream prompt or
 * api-key field gets scrubbed before the sink ever sees it.
 *
 * The sanitizer rejects unserializable values up front (functions,
 * symbols, bigints) so the artifact never crashes the JSON layer.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "api_key",
  "anthropicApiKey",
  "ANTHROPIC_API_KEY",
  "authorization",
  "Authorization",
  "systemPrompt",
  "system_prompt",
  "userPrompt",
  "user_prompt",
  "prompt",
  "env",
  "process",
  "secret",
  "password",
  "token",
]);

export function sanitizePayload(value: unknown): unknown {
  return sanitizeInner(value, new WeakSet());
}

function sanitizeInner(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "undefined") return undefined;
  if (t === "function" || t === "symbol" || t === "bigint") return "<dropped>";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "<cycle>";
    seen.add(value);
    return value.map((v) => sanitizeInner(v, seen));
  }
  if (t === "object" && value !== null) {
    if (seen.has(value as object)) return "<cycle>";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = sanitizeInner(v, seen);
    }
    return out;
  }
  return "<unknown>";
}

/**
 * Defensive sink invocation. Mirrors `safeInvokeFailureSink` for failed
 * AgentRun rows: a sink that throws or rejects must never replace the
 * underlying validation error. Logs to stderr and swallows.
 */
export async function safeInvokeDiagnosticSink(
  sink: RunnerDiagnosticSink | undefined,
  artifact: RunnerDiagnosticArtifact,
): Promise<void> {
  if (!sink) return;
  try {
    await sink(artifact);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[diagnostic-artifact] sink threw on artifact ${artifact.id} (${artifact.role}): ${message}`,
    );
  }
}
