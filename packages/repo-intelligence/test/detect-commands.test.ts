import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveBuildCommand,
  deriveTestCommand,
  detectPackageManager,
} from "../src/detect-commands.js";

describe("deriveBuildCommand", () => {
  it("returns '<pm> build' when scripts.build is defined", () => {
    expect(deriveBuildCommand({ build: "tsc -p ." }, "pnpm")).toBe("pnpm build");
    expect(deriveBuildCommand({ build: "rollup -c" }, "npm")).toBe("npm build");
    expect(deriveBuildCommand({ build: "vite build" }, "yarn")).toBe(
      "yarn build",
    );
  });

  it("returns undefined when scripts.build is missing or non-string", () => {
    expect(deriveBuildCommand(undefined, "pnpm")).toBeUndefined();
    expect(deriveBuildCommand({}, "pnpm")).toBeUndefined();
    expect(deriveBuildCommand({ build: 42 }, "pnpm")).toBeUndefined();
  });
});

describe("deriveTestCommand", () => {
  it("returns '<pm> test' when scripts.test is defined", () => {
    expect(deriveTestCommand({ test: "vitest" }, "pnpm")).toBe("pnpm test");
    expect(deriveTestCommand({ test: "jest" }, "npm")).toBe("npm test");
  });

  it("returns undefined when scripts.test is missing", () => {
    expect(deriveTestCommand(undefined, "pnpm")).toBeUndefined();
    expect(deriveTestCommand({ build: "x" }, "pnpm")).toBeUndefined();
  });
});

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pm-go-pm-detect-"));
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 'pnpm' when pnpm-lock.yaml exists", async () => {
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns 'npm' when only package-lock.json exists", async () => {
    await writeFile(join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("returns 'yarn' when only yarn.lock exists", async () => {
    await writeFile(join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("defaults to 'pnpm' when no lockfiles exist", () => {
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("prefers pnpm when multiple lockfiles exist", async () => {
    await writeFile(join(tmpDir, "pnpm-lock.yaml"), "");
    await writeFile(join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });
});
