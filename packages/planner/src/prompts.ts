import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type PromptName = "planner" | "implementer" | "reviewer";

/**
 * Canonical prompt-version registry. Every .md file under
 * packages/planner/prompts/ must have a matching entry here; the
 * prompt-registry test enforces the bidirectional invariant.
 */
export const PROMPT_VERSIONS: Record<PromptName, number> = {
  planner: 1,
  implementer: 1,
  reviewer: 1,
};

/**
 * loadPrompt reads a prompt file relative to this package's prompts/
 * directory. It strips any YAML front-matter block delimited by lines
 * containing exactly `---` if present, so prompt authors can annotate
 * metadata without it leaking into model input.
 */
export function loadPrompt(name: PromptName, version: number): string {
  const url = new URL(
    `../prompts/${name}.v${version}.md`,
    import.meta.url,
  );
  const body = readFileSync(fileURLToPath(url), "utf8");
  return stripFrontMatter(body);
}

function stripFrontMatter(body: string): string {
  // Normalize BOM and leading whitespace-only lines before the fence check.
  const normalized = body.startsWith("\uFEFF") ? body.slice(1) : body;
  const lines = normalized.split(/\r?\n/);
  if (lines[0] !== "---") {
    return normalized;
  }
  // Find the closing fence.
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
    }
  }
  return normalized;
}
