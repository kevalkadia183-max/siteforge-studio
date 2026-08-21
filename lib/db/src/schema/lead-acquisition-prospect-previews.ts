/**
 * lead_acquisition_prospect_previews — signed public prospect preview links.
 *
 * One row per active prospect preview mapping. Uses high-entropy mapping ids
 * with HMAC signatures rather than raw tokens. Revoked on archive/convert/regenerate.
 * FK on prospectSiteId cascades delete so lifecycle cleanup is automatic.
 */
import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { siteforgeUsersTable } from "./siteforge-users";
import { leadsTable } from "./lead-acquisition-leads";
import { prospectSitesTable } from "./lead-acquisition-prospect-sites";
import { clientPreviewsTable } from "./client-previews";
import { siteforgeWebsitesTable } from "./siteforge-websites";

export const prospectPreviewsTable = pgTable(
  "lead_acquisition_prospect_previews",
  {
    /**
     * High-entropy random mapping id (public, in URL path).
     * Maps to prospectSiteId + websiteId for content lookup.
     */
    mappingId: text("mapping_id").primaryKey(),

    /**
     * HMAC-SHA256 signature over mappingId using SESSION_SECRET.
     * Stored hashed so the raw signature is never in the DB.
     */
    signatureHash: text("signature_hash").notNull(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id),

    /**
     * FK to the prospect site lifecycle row.
     * Cascades delete so revocation on lifecycle cleanup is automatic.
     */
    prospectSiteId: text("prospect_site_id")
      .notNull()
      .references(() => prospectSitesTable.id, { onDelete: "cascade" }),

    /**
     * FK to the frozen client_previews row holding the exact generated site
     * that was published for this prospect preview. ON DELETE CASCADE so that
     * deleting the frozen preview row (revoke / archive / convert / regenerate
     * / expired-ordinary-cleanup) also removes this mapping. This guarantees
     * the published revision is served verbatim on public delivery — the
     * website projectSource is never re-read or re-generated for prospects.
     */
    clientPreviewIdHash: text("client_preview_id_hash")
      .notNull()
      .references(() => clientPreviewsTable.idHash, { onDelete: "cascade" }),

    /**
     * The specific website id this preview renders.
     * After regeneration this differs from the active websiteId.
     */
    websiteId: text("website_id").notNull(),

    /**
     * The exact website revision this preview was published for (integer).
     * Used to enforce expectedRevision on publish and verify on delivery.
     */
    websiteRevision: integer("website_revision").notNull(),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("la_prospect_previews_lead_owner_uq").on(
      table.leadId,
      table.ownerId,
    ),
    index("la_prospect_previews_owner_idx").on(table.ownerId),
    index("la_prospect_previews_expires_idx").on(table.expiresAt),
    index("la_prospect_previews_site_idx").on(table.prospectSiteId),
    index("la_prospect_previews_client_preview_idx").on(
      table.clientPreviewIdHash,
    ),
    // Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
    foreignKey({
      name: "la_prospect_previews_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    // Composite FK: (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
    foreignKey({
      name: "la_prospect_previews_owner_site_fk",
      columns: [table.ownerId, table.prospectSiteId],
      foreignColumns: [prospectSitesTable.ownerId, prospectSitesTable.id],
    }),
    // Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
    foreignKey({
      name: "la_prospect_previews_owner_website_fk",
      columns: [table.ownerId, table.websiteId],
      foreignColumns: [siteforgeWebsitesTable.ownerId, siteforgeWebsitesTable.id],
    }),
  ],
);

export const insertProspectPreviewSchema = createInsertSchema(
  prospectPreviewsTable,
).omit({ createdAt: true });
export type InsertProspectPreview = z.infer<typeof insertProspectPreviewSchema>;
export type ProspectPreview = typeof prospectPreviewsTable.$inferSelect;
