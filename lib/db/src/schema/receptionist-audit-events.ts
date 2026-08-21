import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const receptionistAuditEventsTable = pgTable(
  "receptionist_audit_events",
  {
    id: text("id").primaryKey(),
    // Security events can arrive before a trusted receptionist can be identified.
    receptionistId: text("receptionist_id"),
    conversationId: text("conversation_id"),
    messageId: text("message_id"),
    eventType: text("event_type").notNull(), // e.g. 'chat_message', 'email_draft_approving', 'email_draft_reconciled', 'email_draft_retry_ready'
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("receptionist_audit_receptionist_id_idx").on(table.receptionistId),
    index("receptionist_audit_event_type_idx").on(table.eventType),
    index("receptionist_audit_created_at_idx").on(table.createdAt),
  ],
);

export const insertReceptionistAuditEventSchema = createInsertSchema(
  receptionistAuditEventsTable,
).omit({ createdAt: true });
export type InsertReceptionistAuditEvent = z.infer<
  typeof insertReceptionistAuditEventSchema
>;
export type ReceptionistAuditEvent =
  typeof receptionistAuditEventsTable.$inferSelect;
