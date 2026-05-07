import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import type { Plan } from "@pm-go/contracts";

import {
  auditPlanFileScopeForPackageCreation,
  missingLocalManifestScopes,
  missingRootArtifactScopes,
  taskSignalsPackageCreation,
} from "../src/file-scope-hygiene.js";

const fixturePath = fileURLToPath(
  new URL(
    "../../contracts/src/fixtures/orchestration-review/plan.json",
    import.meta.url,
  ),
);

function loadPlan(): Plan {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Plan;
}

describe("taskSignalsPackageCreation", () => {
  it("matches summaries that announce a new workspace package", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Add @pm-go/runtime-detector workspace package";
    task.summary = "Create a new workspace package that owns runtime detection.";
    expect(taskSignalsPackageCreation(task)).toBe(true);
  });

  it("matches summaries that announce workspace package modification", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Modify @pm-go/runtime-detector workspace package";
    task.summary = "Update the workspace package to expose runtime metadata.";
    expect(taskSignalsPackageCreation(task)).toBe(true);
  });

  it("does not match a generic task summary", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Tighten reviewer prompt severity wording";
    task.summary = "Update the reviewer prompt to reserve changes_requested for real defects.";
    expect(taskSignalsPackageCreation(task)).toBe(false);
  });
});

describe("missingLocalManifestScopes", () => {
  it("requires a package manifest when package files are scoped", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.fileScope.includes = ["packages/runtime-detector/src/index.ts"];
    expect(missingLocalManifestScopes(task)).toEqual([
      "packages/runtime-detector/package.json",
    ]);
  });

  it("requires an app manifest when app files are scoped", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.fileScope.includes = ["apps/worker/src/index.ts"];
    expect(missingLocalManifestScopes(task)).toEqual([
      "apps/worker/package.json",
    ]);
  });

  it("reports nothing when the local manifest is scoped", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.fileScope.includes = [
      "packages/runtime-detector/package.json",
      "packages/runtime-detector/src/index.ts",
    ];
    expect(missingLocalManifestScopes(task)).toEqual([]);
  });
});

describe("missingRootArtifactScopes", () => {
  it("reports missing pnpm-lock.yaml and package.json when neither is present", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.fileScope.includes = ["packages/runtime-detector/src/index.ts"];
    expect(missingRootArtifactScopes(task)).toEqual([
      "package.json",
      "pnpm-lock.yaml",
    ]);
  });

  it("reports nothing when both root artifacts are scoped", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.fileScope.includes = [
      "package.json",
      "pnpm-lock.yaml",
      "packages/runtime-detector/package.json",
    ];
    expect(missingRootArtifactScopes(task)).toEqual([]);
  });
});

describe("auditPlanFileScopeForPackageCreation", () => {
  it("flags a package-creation task that omits root artifacts", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Add @pm-go/runtime-detector workspace package";
    task.summary = "Create a new workspace package for runtime detection.";
    task.fileScope.includes = ["packages/runtime-detector/src/index.ts"];

    const findings = auditPlanFileScopeForPackageCreation(plan);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.id).toBe("plan_audit.tasks.fileScope.packageCreation");
    expect(findings[0]!.severity).toBe("medium");
    expect(findings[0]!.summary).toContain("package.json");
    expect(findings[0]!.summary).toContain("pnpm-lock.yaml");
  });

  it("flags a package-modification task that omits required artifacts", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Modify @pm-go/runtime-detector workspace package";
    task.summary = "Update the workspace package to add runtime metadata.";
    task.fileScope.includes = ["packages/runtime-detector/src/index.ts"];

    const findings = auditPlanFileScopeForPackageCreation(plan);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain("package.json");
    expect(findings[0]!.summary).toContain("pnpm-lock.yaml");
    expect(findings[0]!.summary).toContain(
      "packages/runtime-detector/package.json",
    );
  });

  it("flags root-present package work that omits the local manifest", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Modify @pm-go/runtime-detector workspace package";
    task.summary = "Update the workspace package to add runtime metadata.";
    task.fileScope.includes = [
      "package.json",
      "pnpm-lock.yaml",
      "packages/runtime-detector/src/index.ts",
    ];

    const findings = auditPlanFileScopeForPackageCreation(plan);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).not.toContain('"pnpm-lock.yaml"');
    expect(findings[0]!.summary).toContain(
      "packages/runtime-detector/package.json",
    );
  });

  it("passes a package-creation task that includes root artifacts (the v0.8.2 contract)", () => {
    const plan = loadPlan();
    const task = plan.tasks[0]!;
    task.title = "Add @pm-go/runtime-detector workspace package";
    task.summary = "Create a new workspace package for runtime detection.";
    task.fileScope.includes = [
      "package.json",
      "pnpm-lock.yaml",
      "packages/runtime-detector/package.json",
      "packages/runtime-detector/src/index.ts",
    ];

    const findings = auditPlanFileScopeForPackageCreation(plan);
    expect(findings).toHaveLength(0);
  });

  it("ignores tasks that do not signal package creation", () => {
    const plan = loadPlan();
    plan.tasks[0]!.fileScope.includes = ["packages/foo/src/bar.ts"];
    plan.tasks[0]!.title = "Adjust reviewer severity wording";
    plan.tasks[0]!.summary = "Lower noise on polish-only review findings.";
    const findings = auditPlanFileScopeForPackageCreation(plan);
    expect(findings).toHaveLength(0);
  });
});
