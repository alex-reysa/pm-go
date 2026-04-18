import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";

import type { SpecDocument } from "@pm-go/contracts";
import { createSpecIntakeActivities } from "../src/activities/spec-intake.js";

// Load the SpecDocument fixture directly off disk, mirroring the precedent in
// packages/db/test/round-trip.test.ts. The contracts package entry does not
// re-export JSON fixtures, so resolve the file via import.meta.url.
const specDocumentFixturePath = fileURLToPath(
  new URL(
    "../../../packages/contracts/src/fixtures/core/spec-document.json",
    import.meta.url,
  ),
);
const specDocumentFixture: SpecDocument = JSON.parse(
  readFileSync(specDocumentFixturePath, "utf8"),
);

describe("persistSpecDocument", () => {
  it("inserts a spec document and returns its id", async () => {
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ id: specDocumentFixture.id }]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { insert } as any;

    const activities = createSpecIntakeActivities({ db });
    const id = await activities.persistSpecDocument(specDocumentFixture);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: specDocumentFixture.id,
        title: specDocumentFixture.title,
        source: specDocumentFixture.source,
        body: specDocumentFixture.body,
        createdAt: specDocumentFixture.createdAt,
      }),
    );
    expect(returning).toHaveBeenCalledTimes(1);
    expect(id).toBe(specDocumentFixture.id);
  });

  it("throws when insert returns no row", async () => {
    const returning = vi.fn().mockResolvedValueOnce([]);
    const values = vi.fn().mockReturnValue({ returning });
    const insert = vi.fn().mockReturnValue({ values });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = { insert } as any;

    const activities = createSpecIntakeActivities({ db });
    await expect(
      activities.persistSpecDocument(specDocumentFixture),
    ).rejects.toThrow(/persistSpecDocument: insert returned no row/);
  });
});
