/**
 * Verifies that all five Claude-backed runner factory functions do NOT
 * throw synchronously when `apiKey` is omitted and `ANTHROPIC_API_KEY`
 * is absent from the environment. This is the OAuth-fallthrough contract:
 * Claude Code subscription users authenticate via OAuth rather than an
 * API key, so the runner must construct successfully and defer credential
 * errors to call time (runner.run()), not to construction time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude Agent SDK before any runner module is imported so
// the module-level `import { query }` picks up the mock.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    async function* empty(): AsyncGenerator<never, void, unknown> {
      // no messages — construction tests never call .run()
    }
    return empty();
  }),
}));

import {
  createClaudeImplementerRunner,
  createClaudePlannerRunner,
  createClaudeReviewerRunner,
  createClaudePhaseAuditorRunner,
  createClaudeCompletionAuditorRunner,
} from "../src/index.js";

describe("no-throw construction — all five factory functions", () => {
  beforeEach(() => {
    // Remove any ANTHROPIC_API_KEY that might be set in the test
    // environment so the factories see a genuinely absent key.
    vi.unstubAllEnvs();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createClaudeImplementerRunner() does not throw when apiKey is omitted and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createClaudeImplementerRunner()).not.toThrow();
  });

  it("createClaudePlannerRunner() does not throw when apiKey is omitted and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createClaudePlannerRunner()).not.toThrow();
  });

  it("createClaudeReviewerRunner() does not throw when apiKey is omitted and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createClaudeReviewerRunner()).not.toThrow();
  });

  it("createClaudePhaseAuditorRunner() does not throw when apiKey is omitted and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createClaudePhaseAuditorRunner()).not.toThrow();
  });

  it("createClaudeCompletionAuditorRunner() does not throw when apiKey is omitted and ANTHROPIC_API_KEY is unset", () => {
    expect(() => createClaudeCompletionAuditorRunner()).not.toThrow();
  });
});
