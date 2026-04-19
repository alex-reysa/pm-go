import type { BranchNamingInput } from "./types.js";

const PREFIX = "agent/";
// Total branch-name length cap. Matches the 80 chars after the `agent/`
// prefix called out in docs/specs/git-and-worktree-policy.md.
const MAX_BODY_LENGTH = 80;

/**
 * Deterministically build an agent branch name for a task.
 *
 * Shape: `agent/<planId>/<taskId>-<sanitizedSlug>` where the body after
 * `agent/` is truncated to {@link MAX_BODY_LENGTH}. The slug is
 * lowercased and any character outside `[a-z0-9-]` is replaced with a
 * single `-`; runs of `-` collapse and leading/trailing `-` are trimmed
 * so branch names stay `git`-safe.
 */
export function buildBranchName(input: BranchNamingInput): string {
  const sanitizedSlug = sanitizeSlug(input.slug);
  const body = `${input.planId}/${input.taskId}-${sanitizedSlug}`;
  const truncated =
    body.length > MAX_BODY_LENGTH ? body.slice(0, MAX_BODY_LENGTH) : body;
  return `${PREFIX}${truncated}`;
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
