import "server-only";
import { Pool, type PoolClient } from "pg";

/**
 * Database access for the request path.
 *
 * Connects as `vesti_app`, which has SELECT on everything and INSERT/UPDATE on
 * almost nothing. It cannot write orders, fills, or lots — that authority
 * belongs solely to the execution service. If a bug (or a prompt injection
 * reaching this far) ever tries to place a trade from here, Postgres answers
 * with `permission denied for table orders`.
 *
 * `server-only` makes an accidental client import a build error rather than a
 * leaked connection string.
 */

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL_APP;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL_APP is unset. The web app must connect as vesti_app — see .env.example.",
    );
  }
  pool = new Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 });
  return pool;
}

/**
 * Runs a unit of work with the row-level-security identity bound to `userId`.
 *
 * The identity is set with `set_config(..., true)` — transaction-local — so it
 * cannot leak to the next request that borrows this pooled connection. That
 * detail is the whole reason this helper exists rather than a bare
 * `pool.query`: a session-scoped GUC on a pooled connection is a cross-tenant
 * data leak waiting to happen the moment this stops being single-user.
 */
export async function withUser<T>(
  userId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('vesti.current_user_id', $1, true)", [userId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Numeric columns arrive from `pg` as strings to preserve precision. */
export function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number.parseFloat(value);
}
