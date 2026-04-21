import type { UUID, WorkflowEvent } from "@pm-go/contracts";

/**
 * SSE client for `GET /events?planId=...`. Parses the server-sent
 * frames off the fetch body's `ReadableStream`, reconnects with
 * exponential backoff, and carries the last seen event id forward so
 * the server-side `sinceEventId=<...>` query param resumes from
 * exactly where we left off. No native-module dependency, no
 * EventSource polyfill — Node 22's global fetch covers the entire
 * wire format the server already emits.
 */
export interface EventStreamOptions {
  baseUrl: string;
  planId: UUID;
  /** Resume cursor. The server replays any event after this id first. */
  sinceEventId?: UUID;
  onEvent: (event: WorkflowEvent) => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
  /** Signal aborts the stream + prevents further reconnect attempts. */
  signal: AbortSignal;
  /** Max backoff in ms. Defaults to 5_000. */
  maxBackoffMs?: number;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests. Defaults to setTimeout/Promise. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Open the stream and loop indefinitely until the signal aborts. The
 * promise resolves on clean abort; rejects are reserved for
 * unrecoverable programmer errors (never for transport failures,
 * which trigger reconnect).
 */
export async function openEventStream(opts: EventStreamOptions): Promise<void> {
  const {
    baseUrl,
    planId,
    onEvent,
    onOpen,
    onError,
    signal,
    maxBackoffMs = 5_000,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = opts;

  let cursor = opts.sinceEventId;
  let backoff = 250;

  while (!signal.aborted) {
    try {
      const url = new URL(`${baseUrl.replace(/\/+$/, "")}/events`);
      url.searchParams.set("planId", planId);
      if (cursor !== undefined) url.searchParams.set("sinceEventId", cursor);

      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { accept: "text/event-stream" },
        signal,
      });

      if (!res.ok || res.body === null) {
        throw new Error(`sse open: status=${res.status}`);
      }

      onOpen?.();

      // Backoff resets only after the connection produces at least one
      // real event. A server that accepts the connection then closes
      // cleanly with no events (misconfigured endpoint, transient
      // upstream error emitting 200) would otherwise trigger a tight
      // 250ms reconnect loop — keeping the previous backoff makes
      // us behave like a well-formed SSE client.
      for await (const frame of readSseFrames(res.body, signal)) {
        const parsed = parseWorkflowEvent(frame);
        if (parsed !== null) {
          cursor = parsed.id;
          backoff = 250;
          onEvent(parsed);
        }
      }
      // Stream ended without error — fall through to reconnect unless
      // we were aborted mid-iteration.
    } catch (err) {
      if (signal.aborted) return;
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }

    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, maxBackoffMs);
  }
}

interface SseFrame {
  event: string | null;
  id: string | null;
  data: string;
}

/**
 * Stream body → SSE frame iterator. Buffers across chunks so a frame
 * split by a network boundary still parses. Blank line terminates a
 * frame; lines starting with `:` are comments (heartbeats) and skipped.
 */
async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE spec allows \n, \r\n, or \r as line endings. Normalise to
      // \n and split on blank lines.
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const frame = parseFrame(raw);
        if (frame !== null) yield frame;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be closed; nothing to do.
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  if (raw.length === 0) return null;
  const dataLines: string[] = [];
  let event: string | null = null;
  let id: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    // Per SSE spec a space immediately after the colon is stripped.
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        event = value;
        break;
      case "id":
        id = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      // `retry:` / unknown fields: ignored.
    }
  }

  if (dataLines.length === 0 && event === null && id === null) return null;
  return { event, id, data: dataLines.join("\n") };
}

const KNOWN_KINDS = new Set([
  "phase_status_changed",
  "task_status_changed",
  "artifact_persisted",
]);

function parseWorkflowEvent(frame: SseFrame): WorkflowEvent | null {
  // The server emits a `ready` handshake + heartbeat comments; neither
  // carries a WorkflowEvent payload. Filter by event name before
  // paying for JSON.parse.
  if (frame.event === null || !KNOWN_KINDS.has(frame.event)) return null;
  if (frame.data.length === 0) return null;
  try {
    const parsed = JSON.parse(frame.data) as WorkflowEvent;
    return parsed;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) {
      cleanup();
      resolve();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
