/**
 * lead_acquisition_prospect_generations — append-only generation history.
 *
 * Each generation represents one call to generate/regenerate a prospect site.
 * Rows are never updated (append-only); status tracks the lifecycle of each
 * generation.
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
import { prospectSitesTable } from "./lead-acquisition-prospect-sites";
import { siteforgeWebsitesTable } from "./siteforge-websites";

export const prospectGenerationsTable = pgTable(
  "lead_acquisition_prospect_generations",
  {
    id: text("id").primaryKey(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id),

    prospectSiteId: text("prospect_site_id")
      .notNull()
      .references(() => prospectSitesTable.id),

    /**
     * The website id this generation produced.
     * For regenerations this will differ from the previous generation's websiteId.
     */
    websiteId: text("website_id").notNull(),

    /**
     * Generation status:
     *   active     — current live draft generation
     *   superseded — replaced by a newer regeneration
     *   archived   — prospect was archived
     *   converted  — prospect was converted to customer
     *
     * Enforced by DB CHECK constraint.
     */
    status: text("status").notNull().default("active"),

    /** Snapshot of the templateId used at generation time */
    templateId: text("template_id"),

    /** Snapshot of the verified fields used at generation time */
    verifiedFieldsSnapshot: jsonb("verified_fields_snapshot"),

    /**
     * Website revision at time of generation (integer >= 0).
     * Stored as integer (not text) for physical type correctness.
     */
    websiteRevision: integer("website_revision").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
  },
  (table) => [
    index("la_prospect_gens_owner_idx").on(table.ownerId),
    index("la_prospect_gens_lead_idx").on(table.leadId),
    index("la_prospect_gens_site_idx").on(table.prospectSiteId),
    index("la_prospect_gens_website_idx").on(table.websiteId),
    index("la_prospect_gens_status_idx").on(table.status),
    // UNIQUE (owner_id, website_id): each website belongs to at most one generation
    // per owner (each website is created fresh per generation, so this is 1:1)
    uniqueIndex("la_prospect_gens_owner_website_uq").on(
      table.ownerId,
      table.websiteId,
    ),
    // Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
    foreignKey({
      name: "la_prospect_gens_owner_lead_fk",
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leadsTable.ownerId, leadsTable.id],
    }),
    // Composite FK: (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
    foreignKey({
      name: "la_prospect_gens_owner_site_fk",
      columns: [table.ownerId, table.prospectSiteId],
      foreignColumns: [prospectSitesTable.ownerId, prospectSitesTable.id],
    }),
    // Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
    foreignKey({
      name: "la_prospect_gens_owner_website_fk",
      columns: [table.ownerId, table.websiteId],
      foreignColumns: [siteforgeWebsitesTable.ownerId, siteforgeWebsitesTable.id],
    }),
    check(
      "la_prospect_gens_status_check",
      sql`${table.status} IN ('active', 'superseded', 'archived', 'converted')`,
    ),
    check(
      "la_prospect_gens_website_revision_check",
      sql`${table.websiteRevision} >= 0`,
    ),
  ],
);

export const insertProspectGenerationSchema = createInsertSchema(
  prospectGenerationsTable,
).omit({ createdAt: true });
export type InsertProspectGeneration = z.infer<typeof insertProspectGenerationSchema>;
export type ProspectGeneration = typeof prospectGenerationsTable.$inferSelect;
