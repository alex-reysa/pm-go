import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";

export const specDocuments = pgTable("spec_documents", {
  id: uuid("id").primaryKey(),
  title: text("title").notNull(),
  source: text("source", { enum: ["manual", "imported"] }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export type SpecDocumentRow = typeof specDocuments.$inferSelect;
export type SpecDocumentInsert = typeof specDocuments.$inferInsert;
