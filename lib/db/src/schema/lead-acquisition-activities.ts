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
 * lead_acquisition_activities — append-only activity history for a lead.
 * Activity types include: created, updated, scored, suppressed, unsuppressed,
 * status_changed, note_added, imported.
 */
export const leadActivitiesTable = pgTable(
  "lead_acquisition_activities",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),

    activityType: text("activity_type").notNull(),
    note: text("note"),
    performedBy: text("performed_by"), // userId or system identifier

    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("la_activities_lead_idx").on(table.leadId),
    index("la_activities_owner_idx").on(table.ownerId),
    index("la_activities_lead_occurred_idx").on(table.leadId, table.occurredAt),
    index("la_activities_owner_occurred_idx").on(table.ownerId, table.occurredAt),
  ],
);

export const insertLeadActivitySchema = createInsertSchema(leadActivitiesTable).omit({
  occurredAt: true,
});
export type InsertLeadActivity = z.infer<typeof insertLeadActivitySchema>;
export type LeadActivity = typeof leadActivitiesTable.$inferSelect;
