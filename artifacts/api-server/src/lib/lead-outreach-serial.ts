/**
 * Pure, DB-free serialization helpers for outreach draft API records.
 *
 * Extracted here so they can be imported in both the route layer (which has
 * DB access) and pure unit tests (which cannot import DB-connected modules).
 */

import type { LeadOutreachDraft } from "@workspace/db";
import type { FactReference } from "./lead-outreach-copy";

/**
 * Lead context populated server-side via an owner-scoped join.
 * Never accepted from or persisted from the client.
 */
export type LeadContext = {
  /** Lead's businessName from the lead row. Null when absent. */
  businessName: string | null;
  /**
   * Safe recipient display value: lead.email for email-channel drafts,
   * lead.phone for whatsapp-channel drafts. Null when the lead has no value
   * for the relevant contact field. Populated server-side, never from client.
   */
  recipientDisplay: string | null;
};

/**
 * Serialize an outreach draft row to a safe API record. ownerId omitted.
 *
 * `leadContext` is optionally supplied from a server-side JOIN — never from the
 * client. When absent, `leadBusinessName` and `recipientDisplay` are null.
 */
export function serializeOutreachDraft(
  draft: LeadOutreachDraft,
  leadContext?: LeadContext | null,
) {
  return {
    id: draft.id,
    leadId: draft.leadId,
    leadBusinessName: leadContext?.businessName ?? null,
    recipientDisplay: leadContext?.recipientDisplay ?? null,
    channel: draft.channel as "email" | "whatsapp",
    status: draft.status as
      | "draft"
      | "reviewed"
      | "gmail_draft_created"
      | "discarded"
      | "replied",
    gmailState: draft.gmailState as "none" | "requesting" | "created" | "failed",
    subject: draft.subject ?? null,
    body: draft.body,
    factSnapshot: (draft.factSnapshot ?? null) as FactReference[] | null,
    gmailDraftId: draft.gmailDraftId ?? null,
    failureReason: draft.failureReason ?? null,
    reviewed: draft.status === "reviewed" || draft.reviewedAt != null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    reviewedAt: draft.reviewedAt ?? null,
    gmailDraftCreatedAt: draft.gmailDraftCreatedAt ?? null,
    repliedAt: draft.repliedAt ?? null,
    discardedAt: draft.discardedAt ?? null,
  };
}
