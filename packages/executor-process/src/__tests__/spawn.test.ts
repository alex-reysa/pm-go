/**
 * AC-cpa-04: spawnClaude startup-timeout test.
 *
 * Verifies that `spawnClaude` throws `ProcessStartupTimeoutError` when the
 * child process does not emit any stdout within the configured timeout window.
 * The test uses the OS `sleep` binary (macOS / Linux) as a mock binary that
 * runs indefinitely without producing stdout.
 */

import { describe, expect, it } from "vitest";
import {
  ProcessStartupTimeoutError,
  spawnClaude,
} from "../claude/spawn.js";

describe("spawnClaude startup timeout", () => {
  it(
    "throws ProcessStartupTimeoutError when the child emits no stdout within the window",
    async () => {
      await expect(
        spawnClaude(
          // `sleep 100` keeps the process alive for 100 s without stdout.
          ["100"],
          {
            executablePath: "sleep",
            startupTimeoutMs: 150,
          },
        ),
      ).rejects.toThrow(ProcessStartupTimeoutError);
    },
    // Use a generous test timeout to absorb scheduler jitter on slow CI boxes.
    3_000,
  );

  it("ProcessStartupTimeoutError carries the configured timeout value", async () => {
    const err = await spawnClaude(["100"], {
      executablePath: "sleep",
      startupTimeoutMs: 150,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProcessStartupTimeoutError);
    if (err instanceof ProcessStartupTimeoutError) {
      expect(err.timeoutMs).toBe(150);
      expect(err.name).toBe("ProcessStartupTimeoutError");
    }
  }, 3_000);

  it("rejects with ProcessStartupTimeoutError (not a plain Error) so callers can isinstance-check", async () => {
    const err = await spawnClaude(["100"], {
      executablePath: "sleep",
      startupTimeoutMs: 150,
    }).catch((e: unknown) => e);

    // Must be the typed subclass, not just any error.
    expect(err).toBeInstanceOf(ProcessStartupTimeoutError);
    // Must also be an Error so generic catch blocks work.
    expect(err).toBeInstanceOf(Error);
  }, 3_000);
});
