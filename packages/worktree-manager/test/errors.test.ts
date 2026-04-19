import { describe, expect, it } from "vitest";

import { WorktreeManagerError } from "../src/index.js";
import type { WorktreeManagerErrorCode } from "../src/index.js";

describe("WorktreeManagerError", () => {
  it("exposes a tagged `code` union and preserves the message", () => {
    const codes: WorktreeManagerErrorCode[] = [
      "not-a-git-repo",
      "dirty-worktree",
      "lease-not-found",
      "worktree-add-failed",
      "worktree-already-exists",
      "git-command-failed",
    ];
    for (const code of codes) {
      const err = new WorktreeManagerError(code, `msg: ${code}`);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("WorktreeManagerError");
      expect(err.code).toBe(code);
      expect(err.message).toBe(`msg: ${code}`);
    }
  });
});
