import { describe, expect, it } from "vitest";

import {
  parseArgs,
  pollWorkflow,
  resolveField,
  type CliArgs,
} from "./poll-workflow.js";

function makeDeps(opts: {
  payloads: Array<unknown | Error>;
  startTime?: number;
  tickMs?: number;
}) {
  const tickMs = opts.tickMs ?? 1;
  let now = opts.startTime ?? 0;
  const lines: string[] = [];
  let i = 0;
  return {
    deps: {
      fetchOnce: async () => {
        const payload = opts.payloads[i++];
        if (payload === undefined) {
          throw new Error("no more payloads queued");
        }
        if (payload instanceof Error) throw payload;
        return payload;
      },
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      log: (line: string) => {
        lines.push(line);
      },
    },
    lines,
    advanceTime: (ms: number) => {
      now += ms;
    },
    setTickIntervalCost: () => {
      now += tickMs;
    },
  };
}

const BASE_ARGS: CliArgs = {
  url: "http://localhost/x",
  field: "plan.status",
  terminal: ["completed", "failed"],
  intervalSeconds: 1,
  timeoutSeconds: 30,
  strict: false,
};

describe("resolveField", () => {
  it("walks dotted-path fields", () => {
    expect(resolveField({ a: { b: { c: "x" } } }, "a.b.c")).toBe("x");
  });
  it("returns undefined when any segment is missing", () => {
    expect(resolveField({ a: {} }, "a.b.c")).toBeUndefined();
  });
  it("returns undefined when the leaf is not a string", () => {
    expect(resolveField({ a: 1 }, "a")).toBeUndefined();
  });
  it("handles a top-level field", () => {
    expect(resolveField({ status: "ok" }, "status")).toBe("ok");
  });
});

describe("parseArgs", () => {
  it("parses required flags", () => {
    const args = parseArgs([
      "--url",
      "http://x",
      "--field",
      "status",
      "--terminal",
      "ok,failed",
    ]);
    expect(args.url).toBe("http://x");
    expect(args.field).toBe("status");
    expect(args.terminal).toEqual(["ok", "failed"]);
    expect(args.intervalSeconds).toBe(5);
    expect(args.timeoutSeconds).toBe(300);
  });
  it("throws when a required flag is missing", () => {
    expect(() => parseArgs(["--url", "http://x"])).toThrow();
  });
  it("rejects an empty terminal list", () => {
    expect(() =>
      parseArgs([
        "--url",
        "http://x",
        "--field",
        "x",
        "--terminal",
        "  ,",
      ]),
    ).toThrow();
  });
});

describe("pollWorkflow", () => {
  it("returns terminal on the first matching observation", async () => {
    const { deps } = makeDeps({
      payloads: [{ plan: { status: "completed" } }],
    });
    const outcome = await pollWorkflow(BASE_ARGS, deps);
    expect(outcome.status).toBe("terminal");
    expect(outcome.observed).toBe("completed");
    expect(outcome.ticks).toBe(1);
  });

  it("polls through transitional values until reaching a terminal one", async () => {
    const { deps, lines } = makeDeps({
      payloads: [
        { plan: { status: "executing" } },
        { plan: { status: "executing" } },
        { plan: { status: "failed" } },
      ],
    });
    const outcome = await pollWorkflow(BASE_ARGS, deps);
    expect(outcome.status).toBe("terminal");
    expect(outcome.observed).toBe("failed");
    expect(outcome.ticks).toBe(3);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  it("returns timeout when no terminal state is observed", async () => {
    const { deps } = makeDeps({
      payloads: [
        { plan: { status: "executing" } },
        { plan: { status: "executing" } },
        { plan: { status: "executing" } },
        { plan: { status: "executing" } },
      ],
    });
    const outcome = await pollWorkflow(
      { ...BASE_ARGS, timeoutSeconds: 2 },
      deps,
    );
    expect(outcome.status).toBe("timeout");
  });

  it("recovers from a transient fetch error", async () => {
    const { deps, lines } = makeDeps({
      payloads: [
        new Error("ECONNREFUSED"),
        { plan: { status: "completed" } },
      ],
    });
    const outcome = await pollWorkflow(BASE_ARGS, deps);
    expect(outcome.status).toBe("terminal");
    expect(outcome.observed).toBe("completed");
    expect(lines.some((l) => l.includes("fetch error"))).toBe(true);
  });

  it("treats a missing field as transitional", async () => {
    const { deps } = makeDeps({
      payloads: [
        { plan: {} },
        { plan: { status: "completed" } },
      ],
    });
    const outcome = await pollWorkflow(BASE_ARGS, deps);
    expect(outcome.status).toBe("terminal");
    expect(outcome.ticks).toBe(2);
  });
});
