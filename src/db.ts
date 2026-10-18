import pg from "pg";
import { config } from "./config.js";

export type Db = pg.Pool;

export function createDb(): Db {
  return new pg.Pool({ connectionString: config.databaseUrl() });
}

export async function inTransaction<T>(db: Db, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}
