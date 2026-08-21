import {
  withSessionAdvisoryLock,
  type SessionLockedDatabase,
} from "./session-advisory-lock";

/**
 * THE single session-scoped advisory lock that serializes EVERY mutation to an
 * existing lead which can change Do-Not-Contact status, the outreach recipient,
 * the provenance-approved facts, or website/pipeline eligibility.
 *
 * Historically only the outreach handlers held this lock (as
 * `withOutreachLeadLock`). That left a concurrency hole: PATCH /leads/:leadId,
 * PUT/DELETE /leads/:leadId/suppression, and prospect-site generation could
 * mutate the same lead's recipient / suppression / verified facts CONCURRENTLY
 * with an in-flight Gmail draft attempt (which holds this lock across the Gmail
 * provider I/O). Routing all of them through this ONE lock closes the hole:
 * while a Gmail draft is being created, no other lead-state mutation can run,
 * and vice-versa.
 *
 * Key design:
 *  - Keyed by BOTH owner and lead so two owners never contend and a lead id
 *    colliding across owners cannot cross-lock.
 *  - The key string is IDENTICAL to the legacy outreach key
 *    (`outreach-lead-${ownerId}-${leadId}`) so already-shipped outreach
 *    behavior is preserved bit-for-bit and any process still using the old
 *    formula contends correctly during rollout.
 *  - Session (not xact) scoped: held across transactions and across the Gmail
 *    provider POST, released with the connection on process death.
 *
 * Lock ordering (CRITICAL — avoids deadlock with the owner duplicate lock):
 *  - This per-lead SESSION lock is always the OUTER lock.
 *  - `acquireOwnerDuplicateLock` (a per-owner pg_advisory_XACT_lock) is only
 *    ever taken INSIDE `lockedDb.transaction(...)` while already holding this
 *    lock, i.e. strictly INNER. All call sites obey lead-lock → owner-xact-lock,
 *    so there is a single global ordering and no lock-acquisition cycle.
 */

/** The scoped DB session handle available while the per-lead lock is held. */
export type LeadMutationLockedDb = SessionLockedDatabase;

/**
 * Compute the single advisory-lock key that serializes ALL state mutations for
 * one (owner, lead). Every mutating handler that can change DNC / recipient /
 * facts / eligibility MUST use exactly this key so they are mutually exclusive.
 */
export function leadMutationLockKey(ownerId: string, leadId: string): string {
  return `outreach-lead-${ownerId}-${leadId}`;
}

/**
 * Run `operation` while holding the single per-(owner,lead) lead-mutation lock.
 * The operation receives the scoped session handle (`lockedDb`); it MUST do ALL
 * of its DB work through that handle (and its `.transaction()`), never through
 * the global `db`, so every mutation runs on the locked connection.
 *
 * Acquire this ONCE at the top of a handler. Do not nest it for the same key.
 */
export async function withLeadMutationLock<T>(
  ownerId: string,
  leadId: string,
  // eslint-disable-next-line no-unused-vars
  operation: (lockedDb: LeadMutationLockedDb) => Promise<T>,
  // eslint-disable-next-line no-unused-vars
  onUnlockFailure?: (error: unknown) => void,
): Promise<T> {
  return withSessionAdvisoryLock(
    leadMutationLockKey(ownerId, leadId),
    operation,
    onUnlockFailure,
  );
}
