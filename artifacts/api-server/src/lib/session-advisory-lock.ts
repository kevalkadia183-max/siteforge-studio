import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "@workspace/db";

/**
 * Generic SESSION-scoped Postgres advisory lock primitive.
 *
 * This is the shared, process-death-safe core used by every session-level
 * advisory lock in the codebase (receptionist Gmail draft approval AND the
 * unified lead-mutation lock). Keeping one implementation guarantees the lock
 * semantics — checked-out client, pg_advisory_lock/unlock on the SAME
 * connection, and destroy-on-unlock-failure — can never drift between callers.
 *
 * Semantics:
 *  - Checks out ONE pool client and runs all `operation` DB work on it, so a
 *    session lock and the work it guards share a single backend connection.
 *  - `pg_advisory_lock(hashtextextended(key, 0))` blocks until the lock is free;
 *    it is a SESSION lock (not xact), so it is held across transactions and
 *    across external provider I/O performed inside `operation`.
 *  - On completion it calls `pg_advisory_unlock`. If the unlock reports the lock
 *    was NOT held (or throws), the client is DESTROYED on release so a
 *    connection that might still hold a server-side lock is never returned to
 *    the pool. If the process dies mid-operation, Postgres releases all session
 *    advisory locks when the backend connection drops — no stuck locks.
 */

/**
 * The scoped database handle passed to the operation callback while the lock is
 * held. Exposes the same connection for all DB work (select/update/insert) and
 * `transaction()` so callers can open serialised transactions under the lock.
 */
export type SessionLockedDatabase = Pick<
  ReturnType<typeof drizzle>,
  "select" | "update" | "insert" | "delete" | "execute" | "transaction"
>;

export async function withSessionAdvisoryLock<T>(
  lockKey: string,
  // eslint-disable-next-line no-unused-vars
  operation: (database: SessionLockedDatabase) => Promise<T>,
  // eslint-disable-next-line no-unused-vars
  onUnlockFailure?: (error: unknown) => void,
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = false;

  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      lockKey,
    ]);
    return await operation(drizzle(client) as unknown as SessionLockedDatabase);
  } finally {
    try {
      const unlockResult = await client.query<{ unlocked: boolean }>(
        "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
        [lockKey],
      );
      if (!unlockResult.rows[0]?.unlocked) {
        destroyClient = true;
        onUnlockFailure?.(
          new Error("Session advisory lock was not held during release"),
        );
      }
    } catch (error) {
      destroyClient = true;
      onUnlockFailure?.(error);
    }
    client.release(destroyClient);
  }
}
