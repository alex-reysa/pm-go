import type { SpecDocument } from "@pm-go/contracts";
import { specDocuments, type PmGoDb } from "@pm-go/db";

export interface PersistSpecDocumentDeps {
  db: PmGoDb;
}

export function createSpecIntakeActivities({ db }: PersistSpecDocumentDeps) {
  return {
    async persistSpecDocument(input: SpecDocument): Promise<string> {
      const [row] = await db
        .insert(specDocuments)
        .values({
          id: input.id,
          title: input.title,
          source: input.source,
          body: input.body,
          createdAt: input.createdAt,
        })
        .returning({ id: specDocuments.id });
      if (!row) {
        throw new Error("persistSpecDocument: insert returned no row");
      }
      return row.id;
    },
  };
}
