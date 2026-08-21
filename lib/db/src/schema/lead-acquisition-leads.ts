import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
// uniqueIndex is used for the composite (owner_id, id) index to support
// composite FK references from prospect child tables.
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { siteforgeUsersTable } from "./siteforge-users";

/**
 * lead_acquisition_leads — one lead per discovered/imported business prospect.
 * Every row is owner-scoped (ownerId = Clerk userId).
 */
export const leadsTable = pgTable(
  "lead_acquisition_leads",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),

    // Business identification
    businessName: text("business_name").notNull(),
    category: text("category"),
    description: text("description"),

    // Location
    address: text("address"),
    city: text("city"),
    region: text("region"),
    postalCode: text("postal_code"),
    country: text("country"),

    // Contact
    phone: text("phone"),
    email: text("email"),
    websiteUrl: text("website_url"),
    listingUrl: text("listing_url"),

    // Discovery data
    rating: real("rating"),
    reviewCount: integer("review_count"),
    services: text("services"),

    // Pipeline / workflow status
    pipelineStatus: text("pipeline_status").notNull().default("new"),
    // new | contacted | qualified | proposal | won | lost | archived

    // Website analysis status (user/import-provided, never auto-inferred)
    websiteStatus: text("website_status").notNull().default("unknown"),
    // unknown | has_website | no_website | placeholder | outdated

    // Source/provenance
    sourceProvider: text("source_provider"),
    sourceReference: text("source_reference"),
    sourceState: text("source_state"),

    // Score (stored redundantly for fast list queries)
    score: integer("score"),              // 0-100
    scoreBand: text("score_band"),        // low | medium | high
    scoredAt: timestamp("scored_at", { withTimezone: true }),

    // Suppression (boolean for correct physical type and index support)
    suppressed: boolean("suppressed").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("la_leads_owner_idx").on(table.ownerId),
    index("la_leads_owner_pipeline_idx").on(table.ownerId, table.pipelineStatus),
    index("la_leads_owner_website_idx").on(table.ownerId, table.websiteStatus),
    index("la_leads_owner_suppressed_idx").on(table.ownerId, table.suppressed),
    index("la_leads_owner_created_idx").on(table.ownerId, table.createdAt),
    index("la_leads_owner_name_idx").on(table.ownerId, table.businessName),
    // UNIQUE index on (owner_id, id) so composite FK references are possible
    uniqueIndex("la_leads_owner_id_uq").on(table.ownerId, table.id),
  ],
);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
