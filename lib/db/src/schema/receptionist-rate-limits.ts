import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Durable rate-limit buckets for receptionist widget (per tenant + IP/session)
export const receptionistRateLimitsTable = pgTable(
  "receptionist_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
  },
  (table) => [
    index("receptionist_rate_limits_window_started_at_idx").on(
      table.windowStartedAt,
    ),
  ],
);

export type ReceptionistRateLimit =
  typeof receptionistRateLimitsTable.$inferSelect;
