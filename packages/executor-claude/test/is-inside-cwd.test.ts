import path from "node:path";
import { describe, it, expect } from "vitest";

import { isInsideCwd } from "../src/planner-runner.js";

describe("isInsideCwd", () => {
  const cwd = path.resolve("/home/user/repo");

  it("accepts the cwd itself", () => {
    expect(isInsideCwd(cwd, cwd)).toBe(true);
  });

  it("accepts direct descendants", () => {
    expect(isInsideCwd("/home/user/repo/src/index.ts", cwd)).toBe(true);
    expect(isInsideCwd("/home/user/repo/nested/deep/file.md", cwd)).toBe(true);
  });

  it("rejects prefix-collision siblings (the security bug)", () => {
    // /home/user/repo-evil starts-with /home/user/repo but is not inside it.
    expect(isInsideCwd("/home/user/repo-evil/secret.txt", cwd)).toBe(false);
    expect(isInsideCwd("/home/user/repository/file.txt", cwd)).toBe(false);
  });

  it("rejects parent directories", () => {
    expect(isInsideCwd("/home/user/other/file.txt", cwd)).toBe(false);
    expect(isInsideCwd("/etc/passwd", cwd)).toBe(false);
  });

  it("normalises relative paths before comparison", () => {
    // path.resolve resolves relative to process.cwd(), so these depend on
    // the ambient cwd; pass in absolute form to the test helper.
    const inside = path.resolve(cwd, "./src/foo.ts");
    const outside = path.resolve(cwd, "../elsewhere/foo.ts");
    expect(isInsideCwd(inside, cwd)).toBe(true);
    expect(isInsideCwd(outside, cwd)).toBe(false);
  });

  it("rejects traversal via .. even when the prefix matches textually", () => {
    // "/home/user/repo/../evil" resolves to "/home/user/evil" which is outside.
    expect(isInsideCwd("/home/user/repo/../evil", cwd)).toBe(false);
  });
});
