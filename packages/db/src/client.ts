import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type PmGoDb = ReturnType<typeof createDb>;

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export async function closeDb(db: PmGoDb): Promise<void> {
  // Drizzle node-postgres exposes the underlying pool via $client
  await (db.$client as pg.Pool).end();
}
