import { afterEach, describe, expect, it } from "vitest";

import { claudeBinaryOption } from "../src/claude-binary-option.js";

const ENV_VAR = "PM_GO_CLAUDE_BINARY";

describe("claudeBinaryOption", () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = original;
    }
  });

  it("returns an empty object when the env var is unset", () => {
    delete process.env[ENV_VAR];
    expect(claudeBinaryOption()).toEqual({});
  });

  it("returns pathToClaudeCodeExecutable when the env var is set", () => {
    process.env[ENV_VAR] = "/usr/local/bin/claude";
    expect(claudeBinaryOption()).toEqual({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    });
  });

  it("trims surrounding whitespace before threading the path through", () => {
    process.env[ENV_VAR] = "  /opt/claude  ";
    expect(claudeBinaryOption()).toEqual({
      pathToClaudeCodeExecutable: "/opt/claude",
    });
  });

  it("treats an empty/whitespace-only env var as unset", () => {
    process.env[ENV_VAR] = "   ";
    expect(claudeBinaryOption()).toEqual({});
  });
});
