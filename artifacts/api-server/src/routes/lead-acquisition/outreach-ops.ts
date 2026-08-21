/**
 * Lead outreach: shared DB operations & serialization.
 *
 * Append-only history, lead-timeline mirroring, DNC/opt-out blocking, and
 * response serialization. Every real action is appended to BOTH the outreach
 * events table and the existing lead activities timeline.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  leadsTable,
  leadOutreachDraftsTable,
  leadOutreachEventsTable,
  leadOutreachOptOutsTable,
  leadSuppressionsTable,
  leadSourcesTable,
  type Lead,
  type LeadOutreachDraft,
} from "@workspace/db";
import {
  OUTREACH_ALLOWED_FIELDS,
  isApprovedProvenance,
  type FactReference,
  type OutreachField,
  type Provenance,
} from "../../lib/lead-outreach-copy";
import { newId } from "./helpers";
import { appendActivity } from "./lead-ops";
export { serializeOutreachDraft, type LeadContext } from "../../lib/lead-outreach-serial";

/** Outreach event types that mirror onto the lead timeline. */
export type OutreachEventType =
  | "created"
  | "edited"
  | "reviewed"
  | "discarded"
  | "gmail_requested"
  | "gmail_created"
  | "gmail_failed"
  | "gmail_reconciliation_pending"
  | "gmail_reconciled"
  | "gmail_retry_ready"
  | "reply_marked"
  | "opted_out";

const EVENT_TIMELINE_NOTE: Record<OutreachEventType, string> = {
  created: "Outreach draft created",
  edited: "Outreach draft edited (review cleared)",
  reviewed: "Outreach draft marked reviewed",
  discarded: "Outreach draft discarded",
  gmail_requested: "Outreach Gmail draft requested",
  gmail_created: "Outreach Gmail draft created",
  gmail_failed: "Outreach Gmail draft attempt rejected",
  gmail_reconciliation_pending:
    "Outreach Gmail draft attempt is awaiting reconciliation",
  gmail_reconciled: "Outreach Gmail draft reconciled from an earlier attempt",
  gmail_retry_ready:
    "Outreach Gmail draft attempt found no draft — a fresh attempt is ready",
  reply_marked: "Outreach reply marked received",
  opted_out: "Lead opted out of outreach",
};

/**
 * Append an immutable outreach event AND mirror it onto the lead timeline.
 * Only ever called for real, verified actions — never invents delivery/reply
 * events.
 */
export async function appendOutreachEvent(
  opts: {
    ownerId: string;
    leadId: string;
    draftId: string;
    eventType: OutreachEventType;
    detail?: Record<string, unknown> | null;
    performedBy: string;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any = db,
): Promise<void> {
  await txOrDb.insert(leadOutreachEventsTable).values({
    id: newId(),
    ownerId: opts.ownerId,
    leadId: opts.leadId,
    draftId: opts.draftId,
    eventType: opts.eventType,
    detail: opts.detail ?? null,
    performedBy: opts.performedBy,
  });

  await appendActivity(
    {
      leadId: opts.leadId,
      ownerId: opts.ownerId,
      activityType: `outreach_${opts.eventType}`,
      note: EVENT_TIMELINE_NOTE[opts.eventType],
      performedBy: opts.performedBy,
    },
    txOrDb,
  );
}

/**
 * Determine whether outreach is blocked for a lead. Returns a human reason when
 * blocked, or null when allowed. Blocks on:
 *   - a durable outreach opt-out row (checked first — most specific reason), or
 *   - general lead suppression (DNC).
 *
 * Opt-out is checked before suppression so that when an opt-out row exists the
 * caller always sees the more specific, user-intentional wording even when the
 * lead is also suppressed (opt-out sets suppressed=true as a side effect).
 *
 * Must be evaluated inside the same transaction that reloads the lead.
 */
export async function findOutreachBlock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any,
  ownerId: string,
  lead: Lead,
): Promise<string | null> {
  // Check opt-out first — this takes priority over generic suppression wording.
  const [optOut] = await txOrDb
    .select({ id: leadOutreachOptOutsTable.id })
    .from(leadOutreachOptOutsTable)
    .where(
      and(
        eq(leadOutreachOptOutsTable.ownerId, ownerId),
        eq(leadOutreachOptOutsTable.leadId, lead.id),
      ),
    )
    .limit(1);
  if (optOut) {
    return "Lead has opted out of outreach — outreach is not allowed.";
  }
  if (lead.suppressed) {
    return "Lead is suppressed (Do Not Contact) — outreach is not allowed.";
  }
  return null;
}

/**
 * Owner confirmation of imported facts for an outreach draft.
 *
 * Writes a `verified` source row for each field that is BOTH selected for the
 * draft AND explicitly present in confirmImportedFields, using the CURRENT
 * stored lead value (never a client-supplied value). This is what upgrades an
 * imported-only field (e.g. businessName) to approved provenance so
 * loadApprovedFacts will subsequently include it. Runs inside the caller's
 * transaction under the per-lead advisory lock. Returns the fields confirmed.
 */
export async function confirmImportedFactSources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: {
    ownerId: string;
    lead: Lead;
    selectedFields: readonly string[];
    confirmImportedFields: readonly string[];
  },
): Promise<string[]> {
  const { ownerId, lead, selectedFields, confirmImportedFields } = opts;
  const selectedSet = new Set<string>(selectedFields);
  const fieldsToConfirm = confirmImportedFields.filter((f) => selectedSet.has(f));
  if (fieldsToConfirm.length === 0) return [];

  const leadRow = lead as unknown as Record<string, unknown>;
  const rows: Array<{
    id: string;
    leadId: string;
    ownerId: string;
    fieldName: string;
    value: string;
    provenance: string;
  }> = [];
  const confirmed: string[] = [];
  for (const field of fieldsToConfirm) {
    const value = leadRow[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    rows.push({
      id: newId(),
      leadId: lead.id,
      ownerId,
      fieldName: field,
      value, // current stored value, never client input
      provenance: "verified",
    });
    confirmed.push(field);
  }
  if (rows.length > 0) {
    await tx.insert(leadSourcesTable).values(rows);
  }
  return confirmed;
}

/**
 * Whether a durable outreach opt-out row exists for this owner+lead. Used by
 * the ordinary unsuppress endpoint to refuse clearing canonical suppression
 * for a permanently opted-out lead. Must run inside the caller's row-lock tx.
 */
export async function hasDurableOutreachOptOut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any,
  ownerId: string,
  leadId: string,
): Promise<boolean> {
  const [row] = await txOrDb
    .select({ id: leadOutreachOptOutsTable.id })
    .from(leadOutreachOptOutsTable)
    .where(
      and(
        eq(leadOutreachOptOutsTable.ownerId, ownerId),
        eq(leadOutreachOptOutsTable.leadId, leadId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Apply a permanent outreach opt-out in ONE transaction (the caller supplies
 * the tx running under the per-lead advisory lock). This is the single source
 * of truth used by the opt-out route so the canonical DNC propagation cannot
 * drift between the route and tests. It:
 *   1. upserts the durable outreach opt-out row,
 *   2. upserts the canonical lead_acquisition_suppressions record (honest
 *      "Outreach opt-out" reason),
 *   3. sets leads.suppressed=true and returns the ACTUAL updated lead,
 *   4. mirrors the suppression onto the lead activity timeline.
 * Per-draft opted_out outreach events are appended by the caller.
 */
export async function applyOutreachOptOut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  opts: {
    ownerId: string;
    leadId: string;
    reason: string | null;
    channel: string | null;
    performedBy: string;
  },
): Promise<{ lead: Lead; suppressionReason: string }> {
  const { ownerId, leadId, reason, channel, performedBy } = opts;

  const suppressionReason = reason
    ? `Outreach opt-out: ${reason}`
    : "Outreach opt-out";

  // 1. Durable outreach opt-out row (permanent; outreach-specific).
  await tx
    .insert(leadOutreachOptOutsTable)
    .values({ id: newId(), leadId, ownerId, reason, channel })
    .onConflictDoUpdate({
      target: [leadOutreachOptOutsTable.ownerId, leadOutreachOptOutsTable.leadId],
      set: { reason, channel, optedOutAt: new Date() },
    });

  // 2. Canonical DNC suppression record — same table every DNC consumer reads.
  await tx
    .insert(leadSuppressionsTable)
    .values({ id: newId(), leadId, ownerId, reason: suppressionReason })
    .onConflictDoUpdate({
      target: [leadSuppressionsTable.leadId, leadSuppressionsTable.ownerId],
      set: { reason: suppressionReason, suppressedAt: new Date() },
    });

  // 3. Flip the denormalized flag and read back actual state.
  const [updatedLead] = await tx
    .update(leadsTable)
    .set({ suppressed: true, updatedAt: new Date() })
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
    .returning();

  // 4. Mirror the canonical suppression onto the lead activity timeline.
  await appendActivity(
    {
      leadId,
      ownerId,
      activityType: "suppressed",
      note: `Do Not Contact: ${suppressionReason}`,
      performedBy,
    },
    tx,
  );

  return { lead: updatedLead as Lead, suppressionReason };
}

/**
 * Load the provenance-approved facts for a lead's allowlisted fields.
 *
 * A field is approved when the CURRENT stored lead value is non-empty AND there
 * exists at least one source row for that field with approved provenance
 * (user_provided | verified). Values ALWAYS come from the current lead row —
 * never from source rows or client input.
 *
 * NO field is special-cased. In particular businessName is treated exactly like
 * every other allowlisted field: it must have an owner-scoped source row with
 * approved provenance (user_provided from a manual create, or verified from an
 * explicit owner confirmation). Imported-only businessName is therefore EXCLUDED
 * until the owner confirms it, which writes a verified source under the lock.
 */
export async function loadApprovedFacts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any,
  ownerId: string,
  lead: Lead,
): Promise<Partial<Record<OutreachField, FactReference>>> {
  const sources = await txOrDb
    .select({
      id: leadSourcesTable.id,
      fieldName: leadSourcesTable.fieldName,
      provenance: leadSourcesTable.provenance,
    })
    .from(leadSourcesTable)
    .where(
      and(
        eq(leadSourcesTable.leadId, lead.id),
        eq(leadSourcesTable.ownerId, ownerId),
      ),
    );

  // Best approved provenance per field (prefer verified over user_provided).
  const approvedByField = new Map<
    string,
    { provenance: Provenance; sourceId: string }
  >();
  for (const s of sources as Array<{
    id: string;
    fieldName: string;
    provenance: string;
  }>) {
    if (!isApprovedProvenance(s.provenance)) continue;
    const existing = approvedByField.get(s.fieldName);
    if (!existing || s.provenance === "verified") {
      approvedByField.set(s.fieldName, {
        provenance: s.provenance as Provenance,
        sourceId: s.id,
      });
    }
  }

  const facts: Partial<Record<OutreachField, FactReference>> = {};
  const leadRow = lead as unknown as Record<string, unknown>;

  for (const field of OUTREACH_ALLOWED_FIELDS) {
    const value = leadRow[field];
    if (typeof value !== "string" || value.trim() === "") continue;

    const approved = approvedByField.get(field);
    if (!approved) continue; // not provenance-approved → excluded (incl. businessName)
    facts[field] = {
      fieldName: field,
      value,
      provenance: approved.provenance,
      sourceId: approved.sourceId,
    };
  }

  return facts;
}


/** Reload an owner-scoped outreach draft FOR UPDATE inside a transaction. */
export async function loadDraftForUpdateTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  ownerId: string,
  draftId: string,
): Promise<LeadOutreachDraft | null> {
  const [draft] = await tx
    .select()
    .from(leadOutreachDraftsTable)
    .where(
      and(
        eq(leadOutreachDraftsTable.id, draftId),
        eq(leadOutreachDraftsTable.ownerId, ownerId),
      ),
    )
    .limit(1)
    .for("update");
  return draft ?? null;
}
