import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SpecDocument } from "../../src/execution.js";
import { specDocumentFixturePath } from "../../src/fixtures/core/index.js";
import {
  SpecDocumentSchema,
  validateSpecDocument,
  type SpecDocumentStatic
} from "../../src/validators/core/spec-document.js";

function loadFixture(): unknown {
  return JSON.parse(readFileSync(specDocumentFixturePath, "utf8"));
}

describe("SpecDocument contract", () => {
  it("accepts the canonical fixture", () => {
    const fixture = loadFixture();
    expect(validateSpecDocument(fixture)).toBe(true);
  });

  it("rejects a fixture whose required `source` field has an invalid value", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["source"] = "invented-source";
    expect(validateSpecDocument(fixture)).toBe(false);
  });

  it("rejects a fixture missing the required `id` field", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    delete fixture["id"];
    expect(validateSpecDocument(fixture)).toBe(false);
  });

  it("rejects a fixture whose `createdAt` is not an ISO-8601 string", () => {
    const fixture = loadFixture() as Record<string, unknown>;
    fixture["createdAt"] = "not a date";
    expect(validateSpecDocument(fixture)).toBe(false);
  });

  it("exposes a TypeBox schema with the expected $id", () => {
    expect(SpecDocumentSchema.$id).toBe("SpecDocument");
  });

  it("has a Static<> type structurally compatible with SpecDocument", () => {
    // Compile-time assertion: a well-formed Static value is assignable
    // to the authoritative `SpecDocument` interface. This fails to
    // type-check if the TypeBox schema drifts from the interface.
    const sample: SpecDocumentStatic = {
      id: "8c7a1f16-1f4a-4e3c-9a6f-3b9d5d2a7f10",
      title: "sample",
      source: "manual",
      body: "body",
      createdAt: "2026-04-18T10:30:00.000Z"
    };
    const asContract: SpecDocument = sample;
    expect(asContract.id).toBe(sample.id);
  });
});
