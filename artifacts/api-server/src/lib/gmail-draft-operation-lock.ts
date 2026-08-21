import {
  withSessionAdvisoryLock,
  type SessionLockedDatabase,
} from "./session-advisory-lock";

/**
 * A scoped database handle passed to the operation callback while the advisory
 * lock is held. It exposes the same connection (checked-out pool client) for
 * all DB work so no extra connections are consumed under the lock.
 *
 * Includes `transaction()` so callers can open a serialised transaction while
 * the lock is still held — required for the outreach opt-out and Gmail draft
 * paths that must atomically check and mutate state under the lock.
 *
 * Backed by the shared `session-advisory-lock` primitive so the receptionist
 * Gmail draft-approval path and the unified lead-mutation lock share EXACTLY
 * the same process-death-safe session-lock semantics.
 */
export type GmailDraftOperationDatabase = SessionLockedDatabase;

export async function withGmailDraftOperationLock<T>(
  messageId: string,
  // eslint-disable-next-line no-unused-vars
  operation: (database: GmailDraftOperationDatabase) => Promise<T>,
  // eslint-disable-next-line no-unused-vars
  onUnlockFailure?: (error: unknown) => void,
): Promise<T> {
  return withSessionAdvisoryLock(messageId, operation, onUnlockFailure);
}
