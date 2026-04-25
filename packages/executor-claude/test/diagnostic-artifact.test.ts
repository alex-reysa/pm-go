import { describe, expect, it, vi } from "vitest";

import {
  buildSchemaValidationDiagnostic,
  safeInvokeDiagnosticSink,
  sanitizePayload,
  type RunnerDiagnosticArtifact,
} from "../src/diagnostic-artifact.js";

describe("buildSchemaValidationDiagnostic", () => {
  it("captures role, schemaRef, validation summary, and SDK metadata", () => {
    const artifact = buildSchemaValidationDiagnostic({
      role: "reviewer",
      schemaRef: "ReviewReport@1",
      validationErrorSummary: "missing required field 'outcome'",
      rawPayload: { taskId: "abc" },
      sdkResultSubtype: "success",
      sessionId: "session-123",
    });
    expect(artifact.role).toBe("reviewer");
    expect(artifact.schemaRef).toBe("ReviewReport@1");
    expect(artifact.validationErrorSummary).toContain("missing required field");
    expect(artifact.sdkResultSubtype).toBe("success");
    expect(artifact.sessionId).toBe("session-123");
    expect(artifact.id).toMatch(/[0-9a-f-]{36}/);
    expect(artifact.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits sdkResultSubtype and sessionId when not provided", () => {
    const artifact = buildSchemaValidationDiagnostic({
      role: "phase-auditor",
      schemaRef: "PhaseAuditReport@1",
      validationErrorSummary: "no payload",
      rawPayload: undefined,
    });
    expect(artifact.sdkResultSubtype).toBeUndefined();
    expect(artifact.sessionId).toBeUndefined();
  });
});

describe("sanitizePayload", () => {
  it("redacts well-known sensitive keys", () => {
    const out = sanitizePayload({
      apiKey: "sk-secret",
      ANTHROPIC_API_KEY: "sk-other",
      systemPrompt: "do not log",
      authorization: "Bearer xyz",
      keepThis: "ok",
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe("<redacted>");
    expect(out.ANTHROPIC_API_KEY).toBe("<redacted>");
    expect(out.systemPrompt).toBe("<redacted>");
    expect(out.authorization).toBe("<redacted>");
    expect(out.keepThis).toBe("ok");
  });

  it("preserves nested structures (arrays + objects)", () => {
    const out = sanitizePayload({
      findings: [
        { id: "f1", severity: "high", title: "x" },
        { id: "f2", severity: "medium", title: "y" },
      ],
    }) as Record<string, unknown>;
    expect(out.findings).toHaveLength(2);
    expect((out.findings as Array<{ id: string }>)[0]!.id).toBe("f1");
  });

  it("survives circular references without throwing", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = { name: "root" };
    a.self = a;
    expect(() => sanitizePayload(a)).not.toThrow();
    const out = sanitizePayload(a) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.self).toBe("<cycle>");
  });

  it("drops non-serializable values rather than crashing", () => {
    const out = sanitizePayload({
      f: () => 1,
      s: Symbol("x"),
      b: 1n,
    }) as Record<string, unknown>;
    expect(out.f).toBe("<dropped>");
    expect(out.s).toBe("<dropped>");
    expect(out.b).toBe("<dropped>");
  });
});

describe("safeInvokeDiagnosticSink", () => {
  it("invokes the sink with the artifact", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const artifact: RunnerDiagnosticArtifact = {
      id: "00000000-0000-4000-8000-000000000000",
      role: "reviewer",
      schemaRef: "ReviewReport@1",
      validationErrorSummary: "x",
      sanitizedStructuredOutput: {},
      createdAt: "2026-04-25T00:00:00.000Z",
    };
    await safeInvokeDiagnosticSink(sink, artifact);
    expect(sink).toHaveBeenCalledWith(artifact);
  });

  it("swallows sink failures so the underlying ValidationError still surfaces", async () => {
    const sink = vi.fn().mockRejectedValue(new Error("sink down"));
    const artifact: RunnerDiagnosticArtifact = {
      id: "00000000-0000-4000-8000-000000000000",
      role: "reviewer",
      schemaRef: "ReviewReport@1",
      validationErrorSummary: "x",
      sanitizedStructuredOutput: {},
      createdAt: "2026-04-25T00:00:00.000Z",
    };
    await expect(safeInvokeDiagnosticSink(sink, artifact)).resolves.toBeUndefined();
  });

  it("is a no-op when no sink is configured", async () => {
    const artifact: RunnerDiagnosticArtifact = {
      id: "00000000-0000-4000-8000-000000000000",
      role: "completion-auditor",
      schemaRef: "CompletionAuditReport@1",
      validationErrorSummary: "x",
      sanitizedStructuredOutput: {},
      createdAt: "2026-04-25T00:00:00.000Z",
    };
    await expect(
      safeInvokeDiagnosticSink(undefined, artifact),
    ).resolves.toBeUndefined();
  });
});
