import { pgEnum, pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";

export const specDocumentSource = pgEnum("spec_document_source", [
  "manual",
  "imported",
]);

export const specDocuments = pgTable("spec_documents", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  source: specDocumentSource("source").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export type SpecDocumentRow = typeof specDocuments.$inferSelect;
export type SpecDocumentInsert = typeof specDocuments.$inferInsert;
