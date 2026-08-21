/**
 * Lead outreach model — owner-scoped, immutable, auditable.
 *
 * Three tables:
 *
 *   lead_acquisition_outreach_drafts
 *     One mutable state row per outreach draft. Every draft belongs to exactly
 *     one owner+lead (composite FK -> lead_acquisition_leads(owner_id, id)).
 *     status/channel/gmail lifecycle are constrained by DB CHECKs. The current
 *     subject/body/snapshot are stored here; every real change is *also*
 *     appended to the append-only history table so nothing is ever lost.
 *
 *   lead_acquisition_outreach_events
 *     Append-only history of every real action taken on a draft
 *     (created, edited, reviewed, discarded, gmail_requested/created/failed,
 *     reply_marked, opted_out). Never updated or deleted.
 *
 *   lead_acquisition_outreach_optouts
 *     Durable, visible per owner+lead outreach opt-out (DNC for outreach).
 *     Presence of a row suppresses outreach immediately; unique on
 *     (owner_id, lead_id). This is distinct from the general lead suppression
 *     table but both block outreach.
 *
 * Client-supplied values are NEVER trusted for ownerId, recipient, facts,
 * Gmail result, or provider status — the server re-reads stored lead values.
 */
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { siteforgeUsersTable } from "./siteforge-users";
import { leadsTable } from "./lead-acquisition-leads";

/**
 * lead_acquisition_outreach_drafts — one mutable draft state row.
 *
 * status lifecycle:
 *   draft      — created, not yet reviewed
 *   reviewed   — human explicitly marked the current copy reviewed
 *   gmail_draft_created — a Gmail draft was created for this outreach
 *   discarded  — draft discarded (terminal)
 *   replied    — a reply was manually marked as received
 *
 * gmailState lifecycle (independent of status for reconciliation safety):
 *   none        — no Gmail draft attempt yet
 *   requesting  — a claim was made and Gmail creation is in flight OR an earlier
 *                 attempt was ambiguous and is awaiting reconciliation. A row in
 *                 this state is NEVER re-POSTed; the endpoint performs a
 *                 lookup-only reconciliation by stable operationKey.
 *   created     — Gmail confirmed a draft was created
 *   failed      — the last attempt was definitively rejected (validation or a
 *                 hard provider rejection). Ambiguous outcomes are NOT "failed";
 *                 they remain "requesting" until reconciled.
 *
 * gmailAttemptStartedAt: set at claim time and preserved across ambiguous
 *   outcomes / process death. Used to enforce the 2-minute reconciliation
 *   safety delay before a not-found lookup is allowed to mark the row
 *   retry-ready. Never cleared while requesting.
 *
 * channel: email | whatsapp. WhatsApp never sends and is always reported as
 *   provider-not-configured by the route layer.
 */
export const leadOutreachDraftsTable = pgTable(
  "lead_acquisition_outreach_drafts",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id),

    // email | whatsapp
    channel: text("channel").notNull().default("email"),

    // draft | reviewed | gmail_draft_created | discarded | replied
    status: text("status").notNull().default("draft"),

    // none | requesting | created | failed
    gmailState: text("gmail_state").notNull().default("none"),

    subject: text("subject"),
    body: text("body").notNull(),

    /**
     * Snapshot of the exact fact values/references used to render this copy.
     * JSONB array of { fieldName, value, provenance, sourceId? }. Audit only —
     * never used to re-render.
     */
    factSnapshot: jsonb("fact_snapshot"),

    /**
     * Stable Message-ID / operation key used for Gmail draft creation and
     * reconciliation. Deterministic per draft so a repeated attempt reconciles
     * to the same Gmail draft rather than creating a duplicate.
     */
    gmailOperationKey: text("gmail_operation_key"),
    gmailDraftId: text("gmail_draft_id"),
    gmailMessageId: text("gmail_message_id"),
    gmailReconciliationToken: text("gmail_reconciliation_token"),

    // Honest failure reason for the last unsuccessful/ambiguous Gmail attempt.
    failureReason: text("failure_reason"),

    /**
     * When the current Gmail creation attempt was claimed (reviewed→requesting).
     * Persisted so the 2-minute reconciliation delay survives ambiguous
     * outcomes and process death. Cleared only when leaving the requesting
     * state (created / retry-ready).
     */
    gmailAttemptStartedAt: timestamp("gmail_attempt_started_at", {
      withTimezone: true,
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // Timestamp of the explicit human review of the *current* copy.
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Timestamp the Gmail draft was confirmed created.
    gmailDraftCreatedAt: timestamp("gmail_draft_created_at", {
      withTimezone: true,
    }),
    // Timestamp a reply was manually marked received.
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
  },
  (table) => [
    index("la_outreach_drafts_owner_idx").on(table.ownerId),
    index("la_outreach_drafts_lead_idx").on(table.leadId),
    index("la_outreach_drafts_owner_lead_idx").on(table.ownerId, table.leadId),
    index("la_outreach_drafts_owner_status_idx").on(
      table.ownerId,
      table.status,
    ),
    index("la_outreach_drafts_owner_channel_idx").on(
      table.ownerId,
      table.channel,
    ),
    index("la_outreach_drafts_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    // UNIQUE (owner_id, id) so child tables can reference via composite FK.
    uniqueIndex("la_outreach_drafts_owner_id_uq").on(table.ownerId, table.id),
    // Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
    foreignKey({
      name: "la_outreach_drafts_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    check(
      "la_outreach_drafts_channel_check",
      sql`${table.channel} IN ('email', 'whatsapp')`,
    ),
    check(
      "la_outreach_drafts_status_check",
      sql`${table.status} IN ('draft', 'reviewed', 'gmail_draft_created', 'discarded', 'replied')`,
    ),
    check(
      "la_outreach_drafts_gmail_state_check",
      sql`${table.gmailState} IN ('none', 'requesting', 'created', 'failed')`,
    ),
  ],
);

export const insertLeadOutreachDraftSchema = createInsertSchema(
  leadOutreachDraftsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertLeadOutreachDraft = z.infer<
  typeof insertLeadOutreachDraftSchema
>;
export type LeadOutreachDraft = typeof leadOutreachDraftsTable.$inferSelect;

/**
 * lead_acquisition_outreach_events — append-only history of real actions.
 * Never updated or deleted.
 */
export const leadOutreachEventsTable = pgTable(
  "lead_acquisition_outreach_events",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id").notNull(),
    leadId: text("lead_id").notNull(),
    draftId: text("draft_id").notNull(),

    /**
     * eventType is one of the real, verified actions:
     *   created | edited | reviewed | discarded |
     *   gmail_requested | gmail_created | gmail_failed |
     *   gmail_reconciliation_pending | gmail_reconciled | gmail_retry_ready |
     *   reply_marked | opted_out
     * gmail_failed is used ONLY for definitive validation/provider rejection.
     * Ambiguous outcomes are audited as gmail_reconciliation_pending, and a
     * confirmed-not-found reconciliation as gmail_retry_ready. A successful
     * lookup-only recovery is gmail_reconciled. Never invents delivery/reply
     * events.
     */
    eventType: text("event_type").notNull(),

    // Optional structured detail for audit (statuses, honest reasons, ids).
    detail: jsonb("detail"),

    performedBy: text("performed_by"), // ownerId or "system"

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("la_outreach_events_draft_idx").on(table.draftId),
    index("la_outreach_events_owner_idx").on(table.ownerId),
    index("la_outreach_events_lead_idx").on(table.leadId),
    index("la_outreach_events_draft_occurred_idx").on(
      table.draftId,
      table.occurredAt,
    ),
    // Composite FK: (owner_id, draft_id) -> outreach_drafts(owner_id, id)
    foreignKey({
      name: "la_outreach_events_owner_draft_fk",
      columns: [table.ownerId, table.draftId],
      foreignColumns: [leadOutreachDraftsTable.ownerId, leadOutreachDraftsTable.id],
    }),
    check(
      "la_outreach_events_type_check",
      sql`${table.eventType} IN ('created', 'edited', 'reviewed', 'discarded', 'gmail_requested', 'gmail_created', 'gmail_failed', 'gmail_reconciliation_pending', 'gmail_reconciled', 'gmail_retry_ready', 'reply_marked', 'opted_out')`,
    ),
  ],
);

export const insertLeadOutreachEventSchema = createInsertSchema(
  leadOutreachEventsTable,
).omit({ occurredAt: true });
export type InsertLeadOutreachEvent = z.infer<
  typeof insertLeadOutreachEventSchema
>;
export type LeadOutreachEvent = typeof leadOutreachEventsTable.$inferSelect;

/**
 * lead_acquisition_outreach_optouts — durable, visible outreach opt-out.
 * Presence suppresses all outreach immediately. Unique per owner+lead.
 */
export const leadOutreachOptOutsTable = pgTable(
  "lead_acquisition_outreach_optouts",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id").notNull(),
    leadId: text("lead_id").notNull(),

    reason: text("reason"),
    // Optional channel scope; null means all channels.
    channel: text("channel"),

    optedOutAt: timestamp("opted_out_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One opt-out per owner+lead.
    uniqueIndex("la_outreach_optouts_owner_lead_uq").on(
      table.ownerId,
      table.leadId,
    ),
    index("la_outreach_optouts_owner_idx").on(table.ownerId),
    // Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
    foreignKey({
      name: "la_outreach_optouts_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    check(
      "la_outreach_optouts_channel_check",
      sql`${table.channel} IS NULL OR ${table.channel} IN ('email', 'whatsapp')`,
    ),
  ],
);

export const insertLeadOutreachOptOutSchema = createInsertSchema(
  leadOutreachOptOutsTable,
).omit({ optedOutAt: true });
export type InsertLeadOutreachOptOut = z.infer<
  typeof insertLeadOutreachOptOutSchema
>;
export type LeadOutreachOptOut = typeof leadOutreachOptOutsTable.$inferSelect;
