import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigStore } from "../../src/main/configStore.js";
import { DEFAULT_API_BASE_URL } from "../../src/shared/config.js";

describe("createConfigStore", () => {
  let dir: string;

  beforeEach(() => {
    // Fresh tmpdir per test so a leaked `config.json` from a
    // previous run can't influence the next. The path is unique
    // (mkdtempSync appends a random suffix) so parallel test
    // workers don't collide either.
    dir = mkdtempSync(join(tmpdir(), "pm-go-desktop-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds the default Config when no file exists yet", () => {
    const store = createConfigStore({ userDataDir: dir });
    expect(store.getConfig()).toEqual({ apiBaseUrl: DEFAULT_API_BASE_URL });
    // First-launch UX requires the file to actually exist on disk
    // (so an operator can `ls "$(userData dir)"` and find it).
    const onDisk = JSON.parse(readFileSync(store.filePath, "utf8")) as unknown;
    expect(onDisk).toEqual({ apiBaseUrl: DEFAULT_API_BASE_URL });
  });

  it("round-trips setApiBaseUrl through disk", () => {
    const store = createConfigStore({ userDataDir: dir });
    const written = store.setApiBaseUrl("http://example.com:4000/");
    // Returned value reflects the normalized form.
    expect(written.apiBaseUrl).toBe("http://example.com:4000");
    // A second store rooted at the same tmpdir reads back the
    // value just written — the round-trip is durable, not just
    // in-memory.
    const reopen = createConfigStore({ userDataDir: dir });
    expect(reopen.getConfig()).toEqual({
      apiBaseUrl: "http://example.com:4000",
    });
  });

  it("normalizes operator input through setApiBaseUrl", () => {
    // Operator pasted a sloppy value — surrounding whitespace,
    // trailing slashes, missing scheme. The store must persist
    // the canonical form so every downstream consumer (the
    // health probe, the renderer status chip, ...) sees one
    // string, not whatever happened to be typed.
    const store = createConfigStore({ userDataDir: dir });
    const written = store.setApiBaseUrl("  localhost:5000///  ");
    expect(written.apiBaseUrl).toBe("http://localhost:5000");
    expect(store.getConfig().apiBaseUrl).toBe("http://localhost:5000");
  });

  it("falls back to defaults when the config file is corrupt JSON", () => {
    // Simulate a crash mid-save (or a hand-edited file that was
    // saved before completion). The desktop must NOT refuse to
    // launch over a malformed preference; it falls back to the
    // default Config.
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "{not valid json", "utf8");
    const store = createConfigStore({ userDataDir: dir });
    expect(store.getConfig()).toEqual({ apiBaseUrl: DEFAULT_API_BASE_URL });
  });

  it("falls back to defaults when the file is empty", () => {
    // Tracks a zero-byte file (some editors create one on `:w`
    // before swapping). Parser must not throw.
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "", "utf8");
    const store = createConfigStore({ userDataDir: dir });
    expect(store.getConfig()).toEqual({ apiBaseUrl: DEFAULT_API_BASE_URL });
  });

  it("creates the userData directory recursively if it doesn't exist", () => {
    const nested = join(dir, "nested", "userData");
    const store = createConfigStore({ userDataDir: nested });
    // The seeded config.json should land at the expected path.
    expect(store.filePath).toBe(join(nested, "config.json"));
    expect(JSON.parse(readFileSync(store.filePath, "utf8"))).toEqual({
      apiBaseUrl: DEFAULT_API_BASE_URL,
    });
  });

  it("exposes filePath rooted at userDataDir", () => {
    const store = createConfigStore({ userDataDir: dir });
    // Pin the file name + directory layout — a rename of
    // `config.json` would be a migration-relevant change.
    expect(store.filePath).toBe(join(dir, "config.json"));
  });

  it("preserves the latest write across repeated setApiBaseUrl calls", () => {
    const store = createConfigStore({ userDataDir: dir });
    store.setApiBaseUrl("http://first.example.com");
    store.setApiBaseUrl("http://second.example.com");
    expect(store.getConfig().apiBaseUrl).toBe("http://second.example.com");
  });
});
