import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// channel: 'chat' | 'email' | 'call'
// status: 'open' | 'closed' | 'escalated'

export const receptionistConversationsTable = pgTable(
  "receptionist_conversations",
  {
    id: text("id").primaryKey(),
    receptionistId: text("receptionist_id").notNull(),
    channel: text("channel").notNull().default("chat"),
    externalId: text("external_id"), // gmail threadId, retell call_id, etc.
    subject: text("subject"),
    status: text("status").notNull().default("open"),
    // per-conversation session token hash (for widget sessions)
    sessionTokenHash: text("session_token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("receptionist_convos_receptionist_id_idx").on(table.receptionistId),
    uniqueIndex("receptionist_convos_external_id_unique").on(
      table.receptionistId,
      table.channel,
      table.externalId,
    ),
    index("receptionist_convos_session_token_hash_idx").on(table.sessionTokenHash),
  ],
);

export const insertReceptionistConversationSchema = createInsertSchema(
  receptionistConversationsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertReceptionistConversation = z.infer<
  typeof insertReceptionistConversationSchema
>;
export type ReceptionistConversation =
  typeof receptionistConversationsTable.$inferSelect;
