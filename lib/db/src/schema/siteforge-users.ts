import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * siteforge_users — one row per Clerk user that has interacted with the API.
 * Created JIT on first authenticated request (upsert by clerkId).
 */
export const siteforgeUsersTable = pgTable(
  "siteforge_users",
  {
    id: text("id").primaryKey(), // Clerk userId
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("siteforge_users_created_at_idx").on(table.createdAt)],
);

export const insertSiteforgeUserSchema = createInsertSchema(
  siteforgeUsersTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertSiteforgeUser = z.infer<typeof insertSiteforgeUserSchema>;
export type SiteforgeUser = typeof siteforgeUsersTable.$inferSelect;
