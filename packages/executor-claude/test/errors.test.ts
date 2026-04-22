import { describe, expect, it } from "vitest";

import {
  ContentFilterError,
  ExecutorError,
  classifyExecutorError,
} from "../src/errors.js";

describe("classifyExecutorError", () => {
  it("promotes a 400 content-filter error to ContentFilterError", () => {
    const raw = {
      status: 400,
      message: "400 invalid_request_error: Output blocked by content filtering policy",
      error: { message: "Output blocked by content filtering policy" },
    };

    const result = classifyExecutorError(raw);

    expect(result).toBeInstanceOf(ContentFilterError);
    expect(result.name).toBe("ContentFilterError");
    expect((result as ContentFilterError).errorReason).toContain("content_filter");
    expect(result.message).toContain("content_filter");
  });

  it("matches content-filter variants (case, hyphen, underscore)", () => {
    for (const phrase of [
      "content filtering policy",
      "Content-Filter triggered",
      "content_filter hit",
      "CONTENT FILTER reject",
    ]) {
      const result = classifyExecutorError({ status: 400, message: phrase });
      expect(result.name).toBe("ContentFilterError");
    }
  });

  it("passes through 400 errors that are not content-filter", () => {
    const raw = new Error("400 invalid_request_error: missing field");
    (raw as { status?: number }).status = 400;

    const result = classifyExecutorError(raw);

    expect(result).toBe(raw);
    expect(result).not.toBeInstanceOf(ContentFilterError);
  });

  it("passes through non-400 errors unchanged", () => {
    const raw = new Error("429 rate_limit_error: slow down");
    (raw as { status?: number }).status = 429;

    const result = classifyExecutorError(raw);

    expect(result).toBe(raw);
    expect(result).not.toBeInstanceOf(ContentFilterError);
  });

  it("reads status from statusCode as a fallback", () => {
    const raw = {
      statusCode: 400,
      message: "Output blocked by content filtering policy",
    };
    const result = classifyExecutorError(raw);
    expect(result.name).toBe("ContentFilterError");
  });

  it("reads message from nested error.message", () => {
    const raw = {
      status: 400,
      error: { message: "Content filter policy" },
    };
    const result = classifyExecutorError(raw);
    expect(result.name).toBe("ContentFilterError");
  });

  it("is idempotent: classifying a ContentFilterError returns it unchanged", () => {
    const existing = new ContentFilterError("content_filter: test");
    const result = classifyExecutorError(existing);
    expect(result).toBe(existing);
  });

  it("coerces non-Error inputs (e.g. strings) to Error", () => {
    const result = classifyExecutorError("raw string failure");
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(ExecutorError);
    expect(result.message).toBe("raw string failure");
  });

  it("ContentFilterError.errorReason is bounded to a short single-line summary", () => {
    const longMessage =
      "Output blocked by content filtering policy\n" +
      "x".repeat(500) +
      "\ntrailing context";
    const result = classifyExecutorError({ status: 400, message: longMessage });
    expect(result).toBeInstanceOf(ContentFilterError);
    const reason = (result as ContentFilterError).errorReason;
    expect(reason.startsWith("content_filter: ")).toBe(true);
    expect(reason.includes("\n")).toBe(false);
    expect(reason.length).toBeLessThanOrEqual(220);
  });
});
