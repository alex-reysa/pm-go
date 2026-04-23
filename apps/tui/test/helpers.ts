/**
 * Shared test helpers for the TUI test suite.
 */

/**
 * Poll `lastFrame()` until every needle in `needles` appears in the
 * rendered output, or until the timeout expires.
 *
 * Prefer this over a fixed `await tick()` + assertion pattern:
 * `await tick(); expect(frame).toContain(x)` — under multi-package
 * `pnpm test` concurrency the fixed 20–40 ms sleep sometimes fires
 * before React Query resolves and Ink paints the next frame, which
 * then surfaces as a substring-miss assertion failure. Polling lets
 * the fast path stay fast while tolerating a loaded CI box.
 */
export async function waitForFrame(
  lastFrame: () => string | undefined,
  needles: string | readonly string[],
  { timeoutMs = 2_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  const needleList = typeof needles === "string" ? [needles] : needles;
  const deadline = Date.now() + timeoutMs;
  let frame = lastFrame() ?? "";
  while (Date.now() < deadline) {
    frame = lastFrame() ?? "";
    if (needleList.every((n) => frame.includes(n))) return frame;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  // Fall through: return the last observed frame and let the caller's
  // `expect(...).toContain(...)` produce the canonical assertion diff.
  return frame;
}
