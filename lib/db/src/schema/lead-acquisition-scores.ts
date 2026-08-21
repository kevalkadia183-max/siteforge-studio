import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { leadsTable } from "./lead-acquisition-leads";

/**
 * lead_acquisition_scores — explainable opportunity score history.
 * Each recalculation appends a new row; the most recent row is current.
 * Scores are deterministic and do not require external fetches.
 */
export const leadScoresTable = pgTable(
  "lead_acquisition_scores",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leadsTable.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),

    score: integer("score").notNull(), // 0-100

    band: text("band").notNull(),       // low | medium | high

    /**
     * reasons: Array of { key, label, points, weight }
     * Stored as JSONB snapshot so historical scoring is reproducible.
     */
    reasons: jsonb("reasons").notNull(),

    /** Snapshot of the weights used during this scoring run */
    weightSnapshot: jsonb("weight_snapshot").notNull(),

    scoredAt: timestamp("scored_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("la_scores_lead_idx").on(table.leadId),
    index("la_scores_lead_scored_idx").on(table.leadId, table.scoredAt),
    index("la_scores_owner_idx").on(table.ownerId),
  ],
);

export const insertLeadScoreSchema = createInsertSchema(leadScoresTable).omit({
  scoredAt: true,
});
export type InsertLeadScore = z.infer<typeof insertLeadScoreSchema>;
export type LeadScore = typeof leadScoresTable.$inferSelect;
