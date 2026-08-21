/**
 * Provider integrations — owner-scoped, provider-neutral persistence.
 *
 * Five tables:
 *
 *   provider_settings
 *     One mutable row per (owner_id, capability) pair. Tracks which provider
 *     is configured, whether it is enabled, its operational status, non-secret
 *     config, and the last known error. No credentials or tokens are ever
 *     stored here — those live in an external secrets store.
 *
 *   provider_audit_events
 *     Immutable append-only record of every significant provider interaction.
 *     Includes outcome, request correlation IDs, and structured detail. Never
 *     updated or deleted. No secret fields.
 *
 *   provider_quota_windows
 *     Durable quota tracking per (owner, capability, provider, windowStart).
 *     Checked nonnegative and used <= limit at the DB layer so the application
 *     can never accidentally over-count.
 *
 *   provider_webhook_deliveries
 *     Idempotency log for inbound webhook events. deliveryKey deduplicates
 *     re-deliveries. No raw webhook bodies are stored — only a payload hash
 *     and structured metadata.
 *
 *   lead_channel_consents
 *     Durable per-channel communication consent per (owner, lead). Presence
 *     of a row with status='granted' is required before sending on regulated
 *     channels (e.g. WhatsApp). Revoked consent blocks sending immediately.
 *
 * Invariants enforced at the DB layer:
 *   - No credential, token, or raw webhook body is persisted here.
 *   - owner_id always references siteforge_users(id).
 *   - lead FK is composite (owner_id, lead_id) to prevent cross-owner access.
 *   - Quota windows can never record negative usage or usage exceeding the limit.
 *   - Webhook delivery keys are unique per provider to prevent double-processing.
 */
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
 * provider_settings — one row per (owner_id, capability).
 *
 * capability values:
 *   discovery          — lead/business discovery APIs
 *   website_analysis   — website analysis/audit providers
 *   image              — image generation/analysis providers
 *   email              — email delivery providers
 *   whatsapp           — WhatsApp messaging providers
 *
 * status lifecycle:
 *   not_configured — no provider selected or credentials not yet set
 *   configured     — provider selected and credentials present (may not be verified)
 *   unavailable    — provider API is unreachable or returned a hard error
 *   rate_limited   — provider is temporarily rate-limited (see rateLimitResetAt)
 *   disabled       — owner explicitly disabled this capability
 *
 * No credentials or tokens are stored in this table. The application must
 * look them up from a secrets store using the providerKey as a lookup hint.
 */
export const providerSettingsTable = pgTable(
  "provider_settings",
  {
    // Effective composite key: one row per owner+capability.
    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    capability: text("capability").notNull(),

    // Which provider implementation is active for this capability.
    // Nullable: absent means no provider is configured.
    providerKey: text("provider_key"),

    // Whether the owner wants this capability active.
    enabled: boolean("enabled").notNull().default(false),

    // Operational status — updated by the application as provider calls succeed/fail.
    status: text("status").notNull().default("not_configured"),

    // Non-secret provider configuration (e.g. region, model name, tier flags).
    // Must NOT contain credentials, API keys, or tokens.
    config: jsonb("config"),

    // Human-readable last error message, if any.
    lastError: text("last_error"),

    // When rate-limit backoff expires (for status='rate_limited').
    rateLimitResetAt: timestamp("rate_limit_reset_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unique owner+capability key: exactly one settings row per pair.
    uniqueIndex("provider_settings_pk").on(table.ownerId, table.capability),
    index("provider_settings_owner_idx").on(table.ownerId),
    check(
      "provider_settings_capability_check",
      sql`${table.capability} IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp')`,
    ),
    check(
      "provider_settings_status_check",
      sql`${table.status} IN ('not_configured', 'configured', 'unavailable', 'rate_limited', 'disabled')`,
    ),
  ],
);

export const insertProviderSettingsSchema = createInsertSchema(
  providerSettingsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertProviderSettings = z.infer<
  typeof insertProviderSettingsSchema
>;
export type ProviderSettings = typeof providerSettingsTable.$inferSelect;

/**
 * provider_audit_events — immutable append-only audit log.
 *
 * Records every significant provider interaction outcome. Never updated or
 * deleted. No secret fields — the detail jsonb must not contain credentials,
 * tokens, or raw response bodies with PII beyond what is already on the lead.
 *
 * eventType examples (enforced by application, not constrained by DB CHECK to
 * allow new event types without schema migrations):
 *   request_sent | response_ok | response_error | rate_limited |
 *   quota_exceeded | signature_verified | signature_rejected |
 *   webhook_received | webhook_processed | webhook_ignored
 *
 * outcome: success | failure | skipped | unknown
 */
export const providerAuditEventsTable = pgTable(
  "provider_audit_events",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    capability: text("capability").notNull(),
    providerKey: text("provider_key").notNull(),
    eventType: text("event_type").notNull(),

    // success | failure | skipped | unknown
    outcome: text("outcome").notNull(),

    // Correlation ID for the outbound request (e.g. UUID generated by app).
    requestId: text("request_id"),

    // Provider-returned reference (e.g. their transaction/message ID).
    externalRef: text("external_ref"),

    // Structured audit detail — no credentials, no raw bodies, no PII beyond lead refs.
    detail: jsonb("detail"),

    // Immutable timestamp — never updated.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Owner+time: fetch all audit events for an owner, most recent first.
    index("provider_audit_owner_time_idx").on(table.ownerId, table.occurredAt),
    // Capability+time: fetch events for a specific capability across all owners.
    index("provider_audit_capability_time_idx").on(
      table.capability,
      table.occurredAt,
    ),
    index("provider_audit_owner_capability_idx").on(
      table.ownerId,
      table.capability,
    ),
    check(
      "provider_audit_capability_check",
      sql`${table.capability} IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp')`,
    ),
    check(
      "provider_audit_outcome_check",
      sql`${table.outcome} IN ('success', 'failure', 'skipped', 'unknown')`,
    ),
  ],
);

export const insertProviderAuditEventSchema = createInsertSchema(
  providerAuditEventsTable,
).omit({ occurredAt: true });
export type InsertProviderAuditEvent = z.infer<
  typeof insertProviderAuditEventSchema
>;
export type ProviderAuditEvent = typeof providerAuditEventsTable.$inferSelect;

/**
 * provider_quota_windows — durable rolling-window quota accounting.
 *
 * One row per (owner_id, capability, provider_key, window_start). The DB
 * enforces two invariants:
 *   1. used >= 0   (never negative)
 *   2. used <= limit  (never over quota)
 *
 * windowEndsAt is informational; enforcement is the application's responsibility.
 * Expired windows may be archived or deleted; active windows are read and
 * incremented atomically (UPDATE ... WHERE used + 1 <= limit).
 */
export const providerQuotaWindowsTable = pgTable(
  "provider_quota_windows",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    capability: text("capability").notNull(),
    providerKey: text("provider_key").notNull(),

    // Inclusive start of the quota window (e.g. truncated to hour/day/month).
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    // Exclusive end of the quota window.
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),

    // Current usage count within this window. DB CHECK: 0 <= used <= limit.
    used: integer("used").notNull().default(0),

    // Maximum allowed usage within this window.
    limit: integer("limit").notNull(),
  },
  (table) => [
    // One quota row per owner+capability+provider+window.
    uniqueIndex("provider_quota_owner_cap_prov_window_uq").on(
      table.ownerId,
      table.capability,
      table.providerKey,
      table.windowStart,
    ),
    index("provider_quota_owner_capability_idx").on(
      table.ownerId,
      table.capability,
    ),
    index("provider_quota_window_ends_idx").on(table.windowEndsAt),
    // Invariant: usage is never negative.
    check("provider_quota_used_nonneg_check", sql`${table.used} >= 0`),
    // Invariant: usage never exceeds the declared limit.
    check(
      "provider_quota_used_lte_limit_check",
      sql`${table.used} <= ${table.limit}`,
    ),
    check(
      "provider_quota_capability_check",
      sql`${table.capability} IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp')`,
    ),
  ],
);

export const insertProviderQuotaWindowSchema = createInsertSchema(
  providerQuotaWindowsTable,
);
export type InsertProviderQuotaWindow = z.infer<
  typeof insertProviderQuotaWindowSchema
>;
export type ProviderQuotaWindow =
  typeof providerQuotaWindowsTable.$inferSelect;

/**
 * provider_webhook_deliveries — idempotency log for inbound webhooks.
 *
 * deliveryKey is the provider's own delivery/event ID; combined with
 * providerKey it is globally unique. Any re-delivery with the same
 * (providerKey, deliveryKey) is a duplicate and must not be re-processed.
 *
 * No raw webhook bodies are stored. payloadHash (e.g. SHA-256 hex) allows
 * detecting payload tampering on re-delivery without retaining the body.
 *
 * ownerId is nullable: some webhooks arrive before the owner can be resolved
 * (e.g. rejected signature, unknown sender). The FK is conditional.
 *
 * processingStatus lifecycle:
 *   received  — webhook arrived and signature was checked; not yet dispatched
 *   processed — successfully dispatched to application logic
 *   ignored   — deliberately skipped (e.g. unknown event type, test event)
 *   failed    — dispatching failed; see failureReason
 */
export const providerWebhookDeliveriesTable = pgTable(
  "provider_webhook_deliveries",
  {
    id: text("id").primaryKey(),

    // Nullable: some rejected/unresolved webhooks cannot be attributed to an owner.
    ownerId: text("owner_id").references(() => siteforgeUsersTable.id),

    providerKey: text("provider_key").notNull(),

    // Provider's own unique delivery/event identifier. Deduplicates re-deliveries.
    deliveryKey: text("delivery_key").notNull(),

    eventType: text("event_type"),
    externalMessageId: text("external_message_id"),

    // SHA-256 (or equivalent) of the raw payload — NOT the raw body itself.
    payloadHash: text("payload_hash").notNull(),

    // Whether the provider signature was verified before processing.
    signatureVerified: boolean("signature_verified").notNull(),

    // received | processed | ignored | failed
    processingStatus: text("processing_status").notNull().default("received"),

    // Non-null only for processingStatus='failed'.
    failureReason: text("failure_reason"),

    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [
    // Idempotency: one delivery record per (provider, delivery key).
    uniqueIndex("provider_webhook_delivery_key_uq").on(
      table.providerKey,
      table.deliveryKey,
    ),
    index("provider_webhook_owner_idx").on(table.ownerId),
    index("provider_webhook_provider_received_idx").on(
      table.providerKey,
      table.receivedAt,
    ),
    index("provider_webhook_status_idx").on(table.processingStatus),
    check(
      "provider_webhook_status_check",
      sql`${table.processingStatus} IN ('received', 'processed', 'ignored', 'failed')`,
    ),
  ],
);

export const insertProviderWebhookDeliverySchema = createInsertSchema(
  providerWebhookDeliveriesTable,
).omit({ receivedAt: true });
export type InsertProviderWebhookDelivery = z.infer<
  typeof insertProviderWebhookDeliverySchema
>;
export type ProviderWebhookDelivery =
  typeof providerWebhookDeliveriesTable.$inferSelect;

/**
 * lead_channel_consents — durable per-channel communication consent.
 *
 * One row per (owner_id, lead_id, channel). A row with status='granted' is
 * required before sending on regulated channels (e.g. WhatsApp). Revocation
 * is immediate: a row with status='revoked' blocks sending even if a prior
 * 'granted' row existed.
 *
 * Only 'whatsapp' is a regulated channel requiring explicit consent today.
 * The schema is forward-compatible with additional channels via CHECK extension.
 *
 * Composite FK (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
 * prevents cross-owner consent records.
 *
 * status values:
 *   granted — explicit consent obtained (see evidenceRef for proof)
 *   revoked — consent was previously granted and has since been withdrawn
 *   unknown — no explicit consent signal; channel must be treated as blocked
 */
export const leadChannelConsentsTable = pgTable(
  "lead_channel_consents",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id").notNull(),
    leadId: text("lead_id").notNull(),

    // whatsapp only for now; CHECK is widened when new regulated channels are added.
    channel: text("channel").notNull(),

    // granted | revoked | unknown
    status: text("status").notNull(),

    // How consent was obtained (e.g. 'opt_in_form', 'import', 'manual').
    source: text("source").notNull(),

    // Reference to external consent evidence (URL, document ID, etc.). No PII stored here.
    evidenceRef: text("evidence_ref"),

    // When consent was first captured for this (owner, lead, channel).
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    // When this row was last updated (e.g. revocation timestamp).
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One consent record per (owner, lead, channel) — updated in place on status change.
    uniqueIndex("lead_channel_consent_owner_lead_channel_uq").on(
      table.ownerId,
      table.leadId,
      table.channel,
    ),
    index("lead_channel_consent_owner_idx").on(table.ownerId),
    index("lead_channel_consent_owner_lead_idx").on(
      table.ownerId,
      table.leadId,
    ),
    // Composite FK: prevents cross-owner consent records.
    foreignKey({
      name: "lead_channel_consent_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    // Only whatsapp today; extend this CHECK (DROP-then-ADD) when adding channels.
    check(
      "lead_channel_consent_channel_check",
      sql`${table.channel} IN ('whatsapp')`,
    ),
    check(
      "lead_channel_consent_status_check",
      sql`${table.status} IN ('granted', 'revoked', 'unknown')`,
    ),
  ],
);

export const insertLeadChannelConsentSchema = createInsertSchema(
  leadChannelConsentsTable,
).omit({ capturedAt: true, updatedAt: true });
export type InsertLeadChannelConsent = z.infer<
  typeof insertLeadChannelConsentSchema
>;
export type LeadChannelConsent = typeof leadChannelConsentsTable.$inferSelect;
