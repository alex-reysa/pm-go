import type { AgentRun } from "@pm-go/contracts";

/**
 * Typed errors thrown by the Claude-backed runners in this package.
 *
 * Why:
 *   The raw SDK surfaces failures as either vendor-specific classes
 *   (`APIError`, `BadRequestError`) or plain `Error` with `status` +
 *   `message` fields. Temporal's `nonRetryableErrorNames` matches by
 *   `error.name`, so untyped errors retry 3x even when the failure is
 *   deterministically bad (e.g. a 400 content-filter policy rejection).
 *
 *   `classifyExecutorError` re-shapes the SDK's untyped 400 into a
 *   well-named `ContentFilterError` so the retry policy in
 *   `PHASE7_RETRY_POLICIES` can short-circuit it.
 */

export abstract class ExecutorError extends Error {
  /**
   * Short, human-readable reason suitable for the
   * `agent_runs.error_reason` column and operator-facing logs. Never
   * includes raw API keys or full prompt bodies.
   */
  readonly errorReason: string;

  constructor(errorReason: string, options?: { cause?: unknown }) {
    super(errorReason);
    this.errorReason = errorReason;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * 400 content-filter policy rejection from the Anthropic API. The SDK
 * message is of the form:
 *   "Output blocked by content filtering policy"
 * Retrying the same prompt is guaranteed to fail identically, so the
 * TaskExecutionWorkflow + TaskFixWorkflow retry policies list this
 * class name in `nonRetryableErrorNames`.
 */
export class ContentFilterError extends ExecutorError {
  override readonly name = "ContentFilterError";
}

/**
 * Inspect an unknown error and promote it to a typed `ExecutorError`
 * when its shape matches a known non-retryable failure. Unknown shapes
 * are returned unchanged (as `Error` when coercible, else wrapped).
 *
 * The classifier is deliberately duck-typed against the SDK's public
 * fields (`status`, `message`, `error.message`) rather than importing
 * the vendor error class — the runner depends on
 * `@anthropic-ai/claude-agent-sdk`, which wraps the underlying
 * `@anthropic-ai/sdk` errors in ways we don't want to couple to.
 */
export function classifyExecutorError(err: unknown): Error {
  if (err instanceof ExecutorError) return err;

  const status = extractStatus(err);
  const message = extractMessage(err);

  if (status === 400 && /content[-_ ]?filter/i.test(message)) {
    return new ContentFilterError(
      summarizeContentFilterMessage(message),
      { cause: err },
    );
  }

  if (err instanceof Error) return err;
  return new Error(message.length > 0 ? message : "unknown executor error");
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const obj = err as { status?: unknown; statusCode?: unknown };
  if (typeof obj.status === "number") return obj.status;
  if (typeof obj.statusCode === "number") return obj.statusCode;
  return undefined;
}

function extractMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (typeof err !== "object" || err === null) return "";
  const obj = err as {
    message?: unknown;
    error?: { message?: unknown; error?: { message?: unknown } };
  };
  const candidates: unknown[] = [
    obj.message,
    obj.error?.message,
    obj.error?.error?.message,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/**
 * Pick a short, operator-facing reason from a classified error. Used by
 * the per-runner failure paths to populate `AgentRun.errorReason` when
 * synthesizing a `status: "failed"` row for the `onFailure` sink.
 */
export function errorReasonFromClassified(classified: unknown): string {
  if (classified instanceof ExecutorError) return classified.errorReason;
  if (classified instanceof Error) {
    return classified.message.length > 0
      ? classified.message
      : "unknown executor error";
  }
  return "unknown executor error";
}

/**
 * Best-effort invocation of a runner's `onFailure` sink. The classified
 * error the runner is about to re-throw must never be buried by a sink
 * exception — any sink error is logged and swallowed so the real
 * failure still surfaces to Temporal's retry-policy gate.
 */
export async function safeInvokeFailureSink(
  sink: ((run: AgentRun) => Promise<void> | void) | undefined,
  run: AgentRun,
): Promise<void> {
  if (!sink) return;
  try {
    await sink(run);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[executor-claude] onFailure sink failed (runId=${run.id} role=${run.role}):`,
      err,
    );
  }
}

function summarizeContentFilterMessage(raw: string): string {
  // Keep the operator-visible reason short and stable. The raw SDK
  // message sometimes includes full prompt echoes in the trailing
  // context; strip to the first line and cap length.
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const trimmed = firstLine.trim();
  const capped = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  return capped.length > 0
    ? `content_filter: ${capped}`
    : "content_filter: Output blocked by content filtering policy";
}
