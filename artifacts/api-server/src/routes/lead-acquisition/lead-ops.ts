/**
 * Lead acquisition: shared DB operations.
 * Score persistence, provenance recording, duplicate-check fetching.
 *
 * ## Duplicate-prevention transaction semantics
 *
 * All three mutating paths that can change duplicate-identifying fields
 * (POST create, POST import, PATCH edit) must:
 *
 *   1. Open a single DB transaction.
 *   2. As the first statement in that transaction, call
 *      `acquireOwnerDuplicateLock(tx, ownerId)` — this issues
 *      `pg_advisory_xact_lock(key)` which blocks until the lock for the owner
 *      is free and holds it until the transaction commits or rolls back.
 *   3. Read the existing leads for duplicate checking inside the same tx using
 *      `fetchLeadsForDuplicateCheckTx`.
 *   4. Perform any INSERT / UPDATE inside the same tx.
 *
 * This guarantees that no two concurrent requests for the same owner can both
 * pass the duplicate check and both write — they are fully serialized.
 *
 * Import acquires the lock once and processes all rows inside a single
 * transaction so the lock is held for the entire batch, not per-row.
 */

import { and, eq, ne } from "drizzle-orm";
import {
  db,
  leadsTable,
  leadScoresTable,
  leadActivitiesTable,
  leadSourcesTable,
} from "@workspace/db";
import { computeLeadScore } from "../../lib/lead-scoring";
import { type ExistingLeadKey } from "../../lib/lead-normalization";
import { computeChangedLeadFields } from "../../lib/lead-change-detection";
import { acquireOwnerDuplicateLock } from "../../lib/lead-advisory-lock";
import {
  type Lead,
  leadForScoring,
  newId,
  PROVENANCE_TRACKED_FIELDS,
} from "./helpers";

// Re-export so route files only need to import from lead-ops
export { acquireOwnerDuplicateLock };

/**
 * Compute score, persist a score-history row, update the lead's denormalized
 * score columns, and append a "scored" activity.
 * Returns the updated lead row.
 *
 * Can be called with the outer `db` (no active tx) or with a tx handle.
 * Pass the tx handle from callers that already hold an advisory lock to keep
 * all writes inside the same transaction.
 */
export async function runAndPersistScore(
  leadId: string,
  ownerId: string,
  lead: Lead,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any = db,
): Promise<Lead> {
  const result = computeLeadScore(leadForScoring(lead));

  await txOrDb.insert(leadScoresTable).values({
    id: newId(),
    leadId,
    ownerId,
    score: result.score,
    band: result.band,
    reasons: result.reasons as unknown as Record<string, unknown>[],
    weightSnapshot: result.weightSnapshot as unknown as Record<string, unknown>,
  });

  const [updated] = await txOrDb
    .update(leadsTable)
    .set({
      score: result.score,
      scoreBand: result.band,
      scoredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
    .returning();

  await txOrDb.insert(leadActivitiesTable).values({
    id: newId(),
    leadId,
    ownerId,
    activityType: "scored",
    note: `Score: ${result.score} (${result.band})`,
    performedBy: "system",
  });

  return updated!;
}

/**
 * Fetch minimal lead fields for duplicate detection — uses outer `db` pool.
 * Optionally excludes one lead (PATCH: exclude the lead being edited).
 *
 * Only use this when NOT inside an advisory-lock transaction.
 * For locked paths, use `fetchLeadsForDuplicateCheckTx`.
 */
export async function fetchLeadsForDuplicateCheck(
  ownerId: string,
  excludeLeadId?: string,
): Promise<ExistingLeadKey[]> {
  return db
    .select({
      id: leadsTable.id,
      phone: leadsTable.phone,
      email: leadsTable.email,
      websiteUrl: leadsTable.websiteUrl,
      businessName: leadsTable.businessName,
      city: leadsTable.city,
    })
    .from(leadsTable)
    .where(
      excludeLeadId
        ? and(eq(leadsTable.ownerId, ownerId), ne(leadsTable.id, excludeLeadId))
        : eq(leadsTable.ownerId, ownerId),
    );
}

/**
 * Fetch minimal lead fields for duplicate detection — runs inside an existing
 * transaction `tx` that already holds the advisory lock.
 *
 * Must be called after `acquireOwnerDuplicateLock(tx, ownerId)` so the read
 * is part of the same serialized critical section.
 */
export async function fetchLeadsForDuplicateCheckTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  ownerId: string,
  excludeLeadId?: string,
): Promise<ExistingLeadKey[]> {
  return tx
    .select({
      id: leadsTable.id,
      phone: leadsTable.phone,
      email: leadsTable.email,
      websiteUrl: leadsTable.websiteUrl,
      businessName: leadsTable.businessName,
      city: leadsTable.city,
    })
    .from(leadsTable)
    .where(
      excludeLeadId
        ? and(eq(leadsTable.ownerId, ownerId), ne(leadsTable.id, excludeLeadId))
        : eq(leadsTable.ownerId, ownerId),
    );
}

/**
 * Build source provenance rows for a set of fields from an input object.
 * Manual creates → "user_provided"; imports → "imported".
 * Never marks imported facts as "verified".
 */
export function buildSourceRecords(
  leadId: string,
  ownerId: string,
  input: Record<string, unknown>,
  provenance: "user_provided" | "imported",
): Array<{
  id: string;
  leadId: string;
  ownerId: string;
  fieldName: string;
  value: string | null;
  provenance: string;
  provider: string | null;
}> {
  const records: ReturnType<typeof buildSourceRecords> = [];
  for (const field of PROVENANCE_TRACKED_FIELDS) {
    const value = input[field];
    if (value != null && value !== "") {
      records.push({
        id: newId(),
        leadId,
        ownerId,
        fieldName: field,
        value: String(value),
        provenance,
        provider: null,
      });
    }
  }
  return records;
}

/**
 * Record provenance + activity for a PATCH /leads/:leadId edit, derived from
 * the ACTUAL before/after difference — NEVER from mere payload presence.
 *
 * Must be called inside the PATCH transaction, AFTER the lead UPDATE, with the
 * locked `existing` row and the `updated` returned row. It:
 *   1. Computes the fields whose effective stored value truly changed
 *      (computeChangedLeadFields, applying null-clear semantics).
 *   2. Writes a `user_provided` source ONLY for provenance-tracked fields that
 *      actually changed, using the NEW stored value from `updated` (never the
 *      client input) — so an unchanged imported businessName is never promoted.
 *   3. Appends an "updated" activity ONLY when something actually changed.
 * Returns the list of changed fields (for the caller's response/logging).
 */
export async function recordLeadEditProvenance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: {
    ownerId: string;
    leadId: string;
    existing: Record<string, unknown>;
    updated: Record<string, unknown>;
    input: Record<string, unknown>;
    performedBy: string;
  },
): Promise<string[]> {
  const { ownerId, leadId, existing, updated, input, performedBy } = opts;

  const changedFields = computeChangedLeadFields(existing, input);

  const changedProvenanceInput = Object.fromEntries(
    changedFields
      .filter((f) => (PROVENANCE_TRACKED_FIELDS as readonly string[]).includes(f))
      .map((f) => [f, updated[f]]),
  );
  const provenanceRecords = buildSourceRecords(
    leadId,
    ownerId,
    changedProvenanceInput,
    "user_provided",
  );
  if (provenanceRecords.length > 0) {
    await tx.insert(leadSourcesTable).values(provenanceRecords);
  }

  if (changedFields.length > 0) {
    await appendActivity(
      {
        leadId,
        ownerId,
        activityType: "updated",
        note: `Fields updated: ${changedFields.join(", ")}`,
        performedBy,
      },
      tx,
    );
  }

  return changedFields;
}

/** Append an activity record to the lead's history */
export async function appendActivity(
  opts: {
    leadId: string;
    ownerId: string;
    activityType: string;
    note: string;
    performedBy: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any = db,
): Promise<void> {
  await txOrDb.insert(leadActivitiesTable).values({
    id: newId(),
    leadId: opts.leadId,
    ownerId: opts.ownerId,
    activityType: opts.activityType,
    note: opts.note,
    performedBy: opts.performedBy,
  });
}
