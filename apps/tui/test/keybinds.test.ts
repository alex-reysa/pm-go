import { describe, expect, it } from "vitest";

import { KEYBINDS, keyEventToToken, matchChord } from "../src/lib/keybinds.js";
import type { Key } from "ink";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

describe("matchChord", () => {
  it("returns exact match for a single-token binding", () => {
    const result = matchChord(["j"]);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.binding.action.kind).toBe("select-next");
    }
  });

  it("returns exact match for a two-token chord (g r → run-task)", () => {
    const result = matchChord(["g", "r"]);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.binding.action.kind).toBe("run-task");
    }
  });

  it("distinguishes case on the final token (g R → release-plan)", () => {
    const resultLower = matchChord(["g", "r"]);
    const resultUpper = matchChord(["g", "R"]);
    expect(resultLower.kind === "exact" && resultLower.binding.action.kind).toBe(
      "run-task",
    );
    expect(resultUpper.kind === "exact" && resultUpper.binding.action.kind).toBe(
      "release-plan",
    );
  });

  it("marks a live prefix when the buffer begins a known chord", () => {
    expect(matchChord(["g"]).kind).toBe("prefix");
  });

  it("rejects an unknown chord", () => {
    expect(matchChord(["g", "x"]).kind).toBe("none");
  });

  it("empty buffer is none (no binding matches the empty string)", () => {
    expect(matchChord([]).kind).toBe("none");
  });
});

describe("keyEventToToken", () => {
  it("maps special keys to named tokens", () => {
    expect(keyEventToToken("", key({ escape: true }))).toBe("esc");
    expect(keyEventToToken("", key({ return: true }))).toBe("enter");
    expect(keyEventToToken("", key({ upArrow: true }))).toBe("up");
    expect(keyEventToToken("", key({ downArrow: true }))).toBe("down");
  });

  it("returns printable characters verbatim (case-sensitive)", () => {
    expect(keyEventToToken("g", key())).toBe("g");
    expect(keyEventToToken("R", key({ shift: true }))).toBe("R");
    expect(keyEventToToken("?", key())).toBe("?");
  });

  it("suppresses ctrl/meta/tab/backspace so they don't wedge the chord buffer", () => {
    expect(keyEventToToken("s", key({ ctrl: true }))).toBeNull();
    expect(keyEventToToken("", key({ tab: true }))).toBeNull();
    expect(keyEventToToken("", key({ backspace: true }))).toBeNull();
  });

  it("returns null for empty input without a named key", () => {
    expect(keyEventToToken("", key())).toBeNull();
  });
});

describe("KEYBINDS table", () => {
  it("binds every TuiAction kind at least once", () => {
    const kinds = new Set(KEYBINDS.map((b) => b.action.kind));
    const expected: ReadonlyArray<string> = [
      "select-next",
      "select-prev",
      "confirm",
      "cancel",
      "help",
      "quit",
      "run-task",
      "review-task",
      "fix-task",
      "integrate-phase",
      "audit-phase",
      "complete-plan",
      "release-plan",
    ];
    for (const kind of expected) {
      expect(kinds.has(kind as (typeof expected)[number])).toBe(true);
    }
  });
});
