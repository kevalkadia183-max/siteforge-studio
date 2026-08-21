import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// role: 'user' | 'assistant' | 'owner' | 'system'
// approvalState: null | 'pending' | 'approving' | 'reconciling' | 'approved' | 'rejected'
// Reconciliation metadata carries an ownership token so only its Gmail lookup
// can complete or reopen an interrupted approval.

export const receptionistMessagesTable = pgTable(
  "receptionist_messages",
  {
    id: text("id").primaryKey(),
    receptionistId: text("receptionist_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    approvalState: text("approval_state"), // null | 'pending' | 'approving' | 'reconciling' | 'approved' | 'rejected'
    externalMessageId: text("external_message_id"), // gmail message id, retell utterance id, etc.
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("receptionist_messages_receptionist_id_idx").on(table.receptionistId),
    index("receptionist_messages_conversation_id_idx").on(table.conversationId),
    uniqueIndex("receptionist_messages_external_message_id_unique").on(
      table.receptionistId,
      table.externalMessageId,
    ),
    index("receptionist_messages_approval_state_idx").on(table.approvalState),
  ],
);

export const insertReceptionistMessageSchema = createInsertSchema(
  receptionistMessagesTable,
).omit({ createdAt: true });
export type InsertReceptionistMessage = z.infer<
  typeof insertReceptionistMessageSchema
>;
export type ReceptionistMessage = typeof receptionistMessagesTable.$inferSelect;
