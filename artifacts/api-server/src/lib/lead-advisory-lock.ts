/**
 * PostgreSQL advisory lock helpers for lead-acquisition duplicate prevention.
 *
 * ## Why advisory locks?
 * Duplicate detection is a read-then-write operation:
 *   1. Read all existing leads for the owner
 *   2. Check whether the new lead collides with any of them
 *   3. Insert the new lead
 *
 * Without synchronisation, two concurrent POST /leads requests for the same
 * owner can both pass step 2 with an empty set and both insert — producing a
 * duplicate row that no unique index can catch (because the matching key lives
 * across columns with complex normalisation).
 *
 * `pg_advisory_xact_lock(bigint)` acquires a session-level exclusive lock that
 * is automatically released when the surrounding transaction commits or rolls
 * back.  We call it inside a Drizzle transaction so the lock lifetime equals
 * the transaction lifetime — no separate release call is required or possible.
 *
 * ## Lock key construction
 * We need a deterministic 64-bit integer per owner.  We derive it as:
 *
 *   namespace  = 0x1a2b_3c4d  (fixed 32-bit namespace — "lead-acq")
 *   ownerHash  = FNV-1a 32-bit hash of the sfUserId string
 *   lockKey    = BigInt(namespace) << 32n | BigInt(ownerHash >>> 0)
 *
 * This is:
 *   - Deterministic: same owner always gets the same key
 *   - Owner-scoped: different owners get different keys (modulo hash collision,
 *     which only causes unnecessary serialisation, never data corruption)
 *   - Namespaced: the fixed high-word separates us from any other advisory lock
 *     users in the same Postgres instance
 *   - Never derived from user-controlled request fields beyond the
 *     authenticated sfUserId (already verified by requireAuth middleware)
 *
 * ## Usage
 * Always call inside a Drizzle transaction callback:
 *
 *   await db.transaction(async (tx) => {
 *     await acquireOwnerDuplicateLock(tx, ownerId);
 *     const existing = await fetchLeadsForDuplicateCheckTx(tx, ownerId);
 *     // ... check duplicates, insert lead — all inside the same tx
 *   });
 *
 * The lock is released automatically when the transaction ends.
 */

import { sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";

/** Fixed 32-bit namespace for lead-acquisition advisory locks. */
const LOCK_NAMESPACE = 0x1a2b_3c4d;

/**
 * FNV-1a 32-bit hash.
 * Produces a stable non-negative 32-bit integer from an arbitrary string.
 * Identical implementation must be used everywhere the key is computed.
 */
export function fnv1a32(str: string): number {
  let hash = 0x811c_9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiply by FNV prime 0x01000193, keeping 32 bits
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0; // unsigned 32-bit
}

/**
 * Derive the 64-bit advisory lock key for a given owner.
 * Returned as a BigInt so it can be safely embedded in SQL.
 */
export function ownerLockKey(ownerId: string): bigint {
  const ownerHash = fnv1a32(ownerId);
  return (BigInt(LOCK_NAMESPACE) << 32n) | BigInt(ownerHash);
}

/**
 * Acquire a pg_advisory_xact_lock for the owner's lead-acquisition namespace.
 *
 * Must be called inside a Drizzle transaction (`tx`).  The lock is
 * automatically released when the transaction commits or rolls back — no
 * manual release is needed or allowed.
 *
 * Blocks until the lock is available (other requests for the same owner
 * serialize here).  Because it is transaction-scoped, the critical section
 * is bounded by the transaction lifetime.
 *
 * @param tx    Drizzle transaction (PgTransaction or compatible)
 * @param ownerId  Authenticated sfUserId — used to derive the lock key.
 *                 Never taken from user-supplied request body fields.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function acquireOwnerDuplicateLock(tx: any, ownerId: string): Promise<void> {
  const lockKey = ownerLockKey(ownerId);
  // pg_advisory_xact_lock takes a bigint; we pass it as a literal so Drizzle
  // does not attempt any parameter binding type-coercion.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${sql.raw(String(lockKey))})`);
}
