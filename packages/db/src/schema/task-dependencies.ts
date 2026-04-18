import {
  boolean,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { planTasks } from "./plan-tasks.js";

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    fromTaskId: uuid("from_task_id")
      .notNull()
      .references(() => planTasks.id, { onDelete: "cascade" }),
    toTaskId: uuid("to_task_id")
      .notNull()
      .references(() => planTasks.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    required: boolean("required").notNull().default(true),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fromTaskId, table.toTaskId] }),
  }),
);

export type TaskDependenciesRow = typeof taskDependencies.$inferSelect;
export type TaskDependenciesInsert = typeof taskDependencies.$inferInsert;
