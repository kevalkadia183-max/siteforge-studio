import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { siteforgeUsersTable } from "./siteforge-users";

export const receptionistsTable = pgTable(
  "receptionists",
  {
    id: text("id").primaryKey(),
    pilotSlot: text("pilot_slot").unique(),
    ownerKeyHash: text("owner_key_hash").notNull(),
    /**
     * Nullable FK to siteforge_users.id — set on creation when a Clerk session
     * is present, or lazily claimed by a valid ownerKey for legacy receptionists.
     * Once set, never overwritten.
     */
    ownerId: text("owner_id").references(() => siteforgeUsersTable.id),
    enabled: boolean("enabled").notNull().default(true),
    businessName: text("business_name").notNull(),
    businessEmail: text("business_email"),
    assistantName: text("assistant_name").notNull().default("Assistant"),
    greeting: text("greeting"),
    knowledge: text("knowledge"),
    faqs: text("faqs"),
    hours: text("hours"),
    serviceArea: text("service_area"),
    escalationContact: text("escalation_contact"),
    prohibitedActions: text("prohibited_actions"),
    safeAutoReplyCategories: text("safe_auto_reply_categories"),
    retellAgentId: text("retell_agent_id"),
    retellPhoneNumber: text("retell_phone_number"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("receptionists_owner_key_hash_idx").on(table.ownerKeyHash),
    index("receptionists_owner_id_idx").on(table.ownerId),
  ],
);

export const insertReceptionistSchema = createInsertSchema(receptionistsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertReceptionist = z.infer<typeof insertReceptionistSchema>;
export type Receptionist = typeof receptionistsTable.$inferSelect;
