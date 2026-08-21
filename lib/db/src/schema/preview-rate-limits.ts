import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const previewRateLimitsTable = pgTable(
  "preview_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull(),
  },
  (table) => [
    index("preview_rate_limits_window_started_at_idx").on(table.windowStartedAt),
  ],
);