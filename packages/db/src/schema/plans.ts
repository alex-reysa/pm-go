import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { Risk } from "@pm-go/contracts";
import { specDocuments } from "./spec-documents.js";
import { repoSnapshots } from "./repo-snapshots.js";

export const planStatus = pgEnum("plan_status", [
  "draft",
  "auditing",
  "approved",
  "blocked",
  "executing",
  "completed",
  "failed",
]);

export const plans = pgTable("plans", {
  id: uuid("id").primaryKey(),
  specDocumentId: uuid("spec_document_id")
    .notNull()
    .references(() => specDocuments.id),
  repoSnapshotId: uuid("repo_snapshot_id")
    .notNull()
    .references(() => repoSnapshots.id),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: planStatus("status").notNull(),
  risks: jsonb("risks").$type<Risk[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
});

export type PlansRow = typeof plans.$inferSelect;
export type PlansInsert = typeof plans.$inferInsert;
