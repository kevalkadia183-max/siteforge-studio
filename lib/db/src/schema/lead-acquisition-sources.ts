import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./lead-acquisition-leads";

/**
 * lead_acquisition_sources — field/source provenance records.
 * Records the origin of each individual fact about a lead.
 * Provenance values:
 *   user_provided — manually entered by the user
 *   imported      — from a bulk import (never auto-verified)
 *   verified      — explicitly confirmed by a human
 *   inferred      — derived from other data
 *   ai_generated  — produced by an AI model
 *   provider      — returned by a third-party discovery provider
 */
export const leadSourcesTable = pgTable(
  "lead_acquisition_sources",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(), // denormalized for owner-scoped queries

    fieldName: text("field_name").notNull(), // e.g. "phone", "websiteUrl", "businessName"
    value: text("value"),

    // Provenance enum
    provenance: text("provenance").notNull(),
    // user_provided | imported | verified | inferred | ai_generated | provider

    provider: text("provider"), // e.g. "google_places", "yelp" when provenance=provider

    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("la_sources_lead_idx").on(table.leadId),
    index("la_sources_owner_idx").on(table.ownerId),
    index("la_sources_lead_field_idx").on(table.leadId, table.fieldName),
  ],
);

export const insertLeadSourceSchema = createInsertSchema(leadSourcesTable).omit({
  recordedAt: true,
});
export type InsertLeadSource = z.infer<typeof insertLeadSourceSchema>;
export type LeadSource = typeof leadSourcesTable.$inferSelect;
