import pg from "pg";

/** Anything the typed queries can run on: the pool, or one client inside a transaction. */
export type Db = pg.Pool | pg.PoolClient | pg.Client;

/**
 * Runs `fn` in one transaction on one connection: a client checked out of `db` if it is a pool,
 * or `db` itself if it is a client already. Commits when `fn` resolves, rolls back when it rejects.
 */
export async function inTransaction<T>(db: Db, fn: (tx: pg.PoolClient | pg.Client) => Promise<T>): Promise<T> {
  const client = db instanceof pg.Pool ? await db.connect() : db;
  // A connection whose rollback failed is not handed back to the pool.
  let broken = false;
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await fn(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        broken = true;
      });
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    if (client !== db) (client as pg.PoolClient).release(broken);
  }
}
