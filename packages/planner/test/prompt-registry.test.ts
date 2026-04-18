import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { PROMPT_VERSIONS, loadPrompt } from "../src/prompts.js";

const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));

interface ParsedPromptFile {
  name: string;
  version: number;
  filename: string;
}

function parseFilenames(): ParsedPromptFile[] {
  const entries = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
  const parsed: ParsedPromptFile[] = [];
  for (const filename of entries) {
    const match = filename.match(/^(.+)\.v(\d+)\.md$/);
    if (!match) {
      throw new Error(
        `prompt file ${filename} does not match <name>.v<version>.md`,
      );
    }
    parsed.push({
      name: match[1]!,
      version: Number(match[2]),
      filename,
    });
  }
  return parsed;
}

describe("prompt registry", () => {
  it("every .md file under prompts/ has a matching entry in PROMPT_VERSIONS", () => {
    const files = parseFilenames();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(PROMPT_VERSIONS).toHaveProperty(file.name);
      const expectedVersion =
        PROMPT_VERSIONS[file.name as keyof typeof PROMPT_VERSIONS];
      expect(expectedVersion).toBe(file.version);
    }
  });

  it("every PROMPT_VERSIONS entry has a matching .md file under prompts/", () => {
    const files = parseFilenames();
    const byName = new Map(files.map((f) => [f.name, f.version]));
    for (const [name, version] of Object.entries(PROMPT_VERSIONS)) {
      expect(byName.get(name)).toBe(version);
    }
  });

  it("loadPrompt reads the on-disk prompt content", () => {
    const body = loadPrompt("planner", PROMPT_VERSIONS.planner);
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("Planner prompt");
  });
});
