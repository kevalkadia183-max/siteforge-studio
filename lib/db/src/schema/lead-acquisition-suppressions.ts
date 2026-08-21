import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./lead-acquisition-leads";

/**
 * lead_acquisition_suppressions — Do Not Contact records.
 * The unique index on (lead_id, owner_id) enforces one active suppression
 * per owner+lead. Suppress/unsuppress operations use ON CONFLICT DO UPDATE
 * (upsert) inside a transaction with row lock on the lead row for race safety.
 */
export const leadSuppressionsTable = pgTable(
  "lead_acquisition_suppressions",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),

    reason: text("reason").notNull(),

    suppressedAt: timestamp("suppressed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Unique: one active suppression row per owner+lead
    uniqueIndex("la_suppressions_lead_owner_uq").on(table.leadId, table.ownerId),
    index("la_suppressions_owner_idx").on(table.ownerId),
  ],
);

export const insertLeadSuppressionSchema = createInsertSchema(
  leadSuppressionsTable,
).omit({ suppressedAt: true });
export type InsertLeadSuppression = z.infer<typeof insertLeadSuppressionSchema>;
export type LeadSuppression = typeof leadSuppressionsTable.$inferSelect;
