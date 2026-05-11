/**
 * Static-import audit for the renderer (acceptance criterion 0004).
 *
 * Renderer code is context-isolated: it runs in a Chromium process
 * with no Node built-ins, no raw Electron IPC, and only `/health`
 * routed through `window.pmGoDesktop.probeHealth`. The CSP in
 * `index.html` enforces some of this at runtime, but a bundler
 * accident (e.g. someone adding `import fs from "node:fs"`) can
 * still slip through and only surface as a cryptic "fs is not
 * defined" at app boot. This test is the source-grep canary: it
 * walks every `.ts` / `.tsx` file in `src/renderer/` and asserts
 * that the import graph stays on the renderer-safe side of the
 * boundary.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_DIR = path.resolve(__dirname, "../../src/renderer");

async function listRendererFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listRendererFiles(full);
      out.push(...nested);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function readAllRendererSources(): Promise<
  Array<{ file: string; contents: string }>
> {
  // Quick existence guard — fail loudly if the directory disappears
  // rather than silently passing on an empty list.
  await stat(RENDERER_DIR);
  const files = await listRendererFiles(RENDERER_DIR);
  return Promise.all(
    files.map(async (file) => ({
      file,
      contents: await readFile(file, "utf8"),
    })),
  );
}

describe("renderer import-graph audit (acceptance criterion 0004)", () => {
  it("does not import any Node built-in module", async () => {
    // Curated list of Node built-ins that have NO business in the
    // renderer. The renderer's Chromium runtime doesn't provide
    // them, and Electron's context isolation strips them anyway.
    // Listing them explicitly (rather than e.g. matching
    // `/node:/`) keeps the check resilient to package-prefixed
    // imports that *do* belong in the renderer (e.g.
    // `react-dom/client`).
    const banned: readonly string[] = [
      "fs",
      "node:fs",
      "fs/promises",
      "node:fs/promises",
      "child_process",
      "node:child_process",
      "path",
      "node:path",
      "os",
      "node:os",
      "net",
      "node:net",
      "http",
      "node:http",
      "https",
      "node:https",
      "stream",
      "node:stream",
      "crypto",
      "node:crypto",
      "url",
      "node:url",
      "module",
      "node:module",
    ];
    const sources = await readAllRendererSources();
    const violations: Array<{ file: string; spec: string }> = [];
    // Cheap import-spec extractor: regex over `from "X"` and
    // `import("X")`. The renderer is small enough that a regex is
    // both correct and easy to audit, vs. dragging in a TS-AST
    // parser.
    const fromRegex = /\bfrom\s+["']([^"']+)["']/g;
    const dynamicRegex = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
    for (const { file, contents } of sources) {
      for (const regex of [fromRegex, dynamicRegex]) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(contents)) !== null) {
          const spec = match[1];
          if (spec !== undefined && banned.includes(spec)) {
            violations.push({ file, spec });
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not import the raw Electron API", async () => {
    // The renderer is sealed off from Electron by design — every
    // call goes through `window.pmGoDesktop`. Importing `electron`
    // (or `electron/renderer`, `@electron/...`) in the renderer
    // would either fail at bundle time or expose ambient IPC,
    // depending on the config; either way, ban it.
    const sources = await readAllRendererSources();
    const offenders = sources.filter(({ contents }) =>
      /\bfrom\s+["']electron(?:[/"]|$)/.test(contents) ||
      /\bfrom\s+["']@electron\//.test(contents),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("does not call fetch() directly in renderer source", async () => {
    // Per criterion 0004: the only API call is /health via
    // pmGoDesktop.probeHealth. Direct fetch() from the renderer is
    // banned — both because it routes around the bridge and because
    // the CSP doesn't allow it.
    const sources = await readAllRendererSources();
    // Tolerate `fetch` as part of an identifier (e.g.
    // `prefetched`), but flag a plain `fetch(` call or
    // `window.fetch(`.
    const fetchCall = /(?<![A-Za-z0-9_$])fetch\s*\(/;
    const windowFetch = /\bwindow\.fetch\b/;
    const offenders = sources.filter(
      ({ contents }) =>
        fetchCall.test(contents) || windowFetch.test(contents),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("only calls /health through pmGoDesktop.probeHealth", async () => {
    // Affirmative check: somewhere in the renderer, we DO route the
    // probe through the bridge. Catches a regression where someone
    // removes the bridge call entirely (which would silently kill
    // the probe loop).
    const sources = await readAllRendererSources();
    const usesBridgeProbe = sources.some(({ contents }) =>
      /\bprobeHealth\s*\(/.test(contents),
    );
    expect(usesBridgeProbe).toBe(true);
    // And nobody is hardcoding `/health` in a string literal —
    // that's the main process's job.
    const offenders = sources.filter(({ contents, file }) => {
      // Allow the comment block(s) that *mention* /health for
      // explanatory purposes; flag only real path-string literals.
      const stripped = contents
        // Drop block comments.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // Drop line comments.
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      return /["']\/health["']/.test(stripped) && !file.endsWith("index.tsx")
        ? true
        : /["']\/health["']/.test(stripped);
    });
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("does not perform file:// navigation or remote module loading", async () => {
    const sources = await readAllRendererSources();
    const bannedPatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "file:// navigation", pattern: /["']file:\/\//i },
      { name: "remote http(s) module import", pattern: /\bimport\(["']https?:\/\// },
      { name: "eval()", pattern: /\beval\s*\(/ },
    ];
    const violations: Array<{ file: string; what: string }> = [];
    for (const { file, contents } of sources) {
      for (const { name, pattern } of bannedPatterns) {
        if (pattern.test(contents)) {
          violations.push({ file, what: name });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
