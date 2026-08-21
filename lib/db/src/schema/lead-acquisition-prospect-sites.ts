/**
 * lead_acquisition_prospect_sites — one row per lead prospect lifecycle.
 *
 * Each lead may have at most one prospect lifecycle record (unique leadId, ownerId).
 * The website column references the owner-scoped website that holds the
 * current active draft (NULL when archived or converted).
 */
import {
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
import { siteforgeWebsitesTable } from "./siteforge-websites";

export const prospectSitesTable = pgTable(
  "lead_acquisition_prospect_sites",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id),

    /**
     * Lifecycle state:
     *   active_draft   — a website exists, preview may be live
     *   archived       — explicitly archived; no website
     *   converted      — lead won; website upgraded to customer type
     */
    state: text("state").notNull().default("active_draft"),
    // active_draft | archived | converted — enforced by DB CHECK

    /**
     * The current active website id (same owner-scope; = siteforge_websites.id).
     * NULL when state is archived or converted (website stays but is no longer
     * the active prospect draft — it transitions to customer on convert).
     */
    websiteId: text("website_id"),

    /**
     * Snapshot of the verified lead fields used at generation time.
     * Stored as JSONB for audit; never used to re-generate.
     */
    verifiedFieldsSnapshot: jsonb("verified_fields_snapshot"),

    /**
     * Generation count — integer >= 0; incremented each time a new generation
     * is created. Stored as integer (not text) for physical type correctness.
     */
    generationCount: integer("generation_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    archivedAt: timestamp("archived_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
  },
  (table) => [
    // UNIQUE (lead_id, owner_id): at most one prospect lifecycle per lead per owner
    uniqueIndex("la_prospect_sites_lead_owner_uq").on(
      table.leadId,
      table.ownerId,
    ),
    // UNIQUE (owner_id, id): needed so child tables can reference via composite FK
    uniqueIndex("la_prospect_sites_owner_id_uq").on(table.ownerId, table.id),
    // UNIQUE (owner_id, website_id): at most one active prospect per website (NULLs allowed)
    uniqueIndex("la_prospect_sites_owner_website_uq").on(
      table.ownerId,
      table.websiteId,
    ),
    index("la_prospect_sites_owner_idx").on(table.ownerId),
    index("la_prospect_sites_owner_state_idx").on(table.ownerId, table.state),
    index("la_prospect_sites_website_idx").on(table.websiteId),
    // Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
    foreignKey({
      name: "la_prospect_sites_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    // Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
    // Nullable website_id: FK only enforced when website_id IS NOT NULL (PostgreSQL behaviour)
    foreignKey({
      name: "la_prospect_sites_owner_website_fk",
      columns: [table.ownerId, table.websiteId],
      foreignColumns: [siteforgeWebsitesTable.ownerId, siteforgeWebsitesTable.id],
    }),
    check(
      "la_prospect_sites_state_check",
      sql`${table.state} IN ('active_draft', 'archived', 'converted')`,
    ),
    check(
      "la_prospect_sites_generation_count_check",
      sql`${table.generationCount} >= 0`,
    ),
  ],
);

export const insertProspectSiteSchema = createInsertSchema(
  prospectSitesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertProspectSite = z.infer<typeof insertProspectSiteSchema>;
export type ProspectSite = typeof prospectSitesTable.$inferSelect;
