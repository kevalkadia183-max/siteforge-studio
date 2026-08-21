import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { siteforgeUsersTable } from "./siteforge-users";

/**
 * siteforge_websites — one row per website per owner.
 * Composite primary key (ownerId, id) lets imported legacy IDs be preserved
 * independently per owner without cross-owner collisions.
 */
export const siteforgeWebsitesTable = pgTable(
  "siteforge_websites",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => siteforgeUsersTable.id),
    id: text("id").notNull(),

    name: text("name").notNull(),
    status: text("status").notNull().default("active"), // active | archived

    /**
     * Website type: 'customer' (default, normal editable site) or 'prospect'
     * (auto-generated lead-acquisition draft, lifecycle-managed).
     * Generic create/import/duplicate/save/rename operations must never set
     * this from client input — it is managed exclusively by the prospect
     * lifecycle service.
     */
    siteType: text("site_type").notNull().default("customer"),

    /** Full editable project shape (pages, sections, media, design tokens, business, receptionist non-secret settings) */
    projectSource: jsonb("project_source").notNull(),

    /** Widget / display settings that are NOT credentials */
    settings: jsonb("settings").notNull().default({}),

    /** Monotonically increasing counter for optimistic concurrency */
    revision: integer("revision").notNull().default(0),

    /** Schema version of the stored projectSource shape */
    schemaVersion: integer("schema_version").notNull().default(1),

    /** Client-side updatedAt timestamp (milliseconds since epoch) */
    sourceUpdatedAt: bigint("source_updated_at", { mode: "number" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    index("siteforge_websites_owner_idx").on(table.ownerId),
    index("siteforge_websites_owner_status_idx").on(table.ownerId, table.status),
    index("siteforge_websites_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt,
    ),
    index("siteforge_websites_owner_type_idx").on(table.ownerId, table.siteType),
    check(
      "siteforge_websites_site_type_check",
      sql`${table.siteType} IN ('customer', 'prospect')`,
    ),
  ],
);

export const insertSiteforgeWebsiteSchema = createInsertSchema(
  siteforgeWebsitesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertSiteforgeWebsite = z.infer<typeof insertSiteforgeWebsiteSchema>;
export type SiteforgeWebsite = typeof siteforgeWebsitesTable.$inferSelect;
