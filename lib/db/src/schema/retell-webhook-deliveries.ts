import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const retellWebhookDeliveriesTable = pgTable(
  "retell_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("retell"),
    deliveryKey: text("delivery_key").notNull(),
    receptionistId: text("receptionist_id").notNull(),
    eventType: text("event_type").notNull(),
    callId: text("call_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    signatureTimestamp: bigint("signature_timestamp", {
      mode: "number",
    }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("retell_webhook_delivery_key_unique").on(
      table.provider,
      table.deliveryKey,
    ),
    index("retell_webhook_receptionist_id_idx").on(table.receptionistId),
    index("retell_webhook_received_at_idx").on(table.receivedAt),
  ],
);

export const insertRetellWebhookDeliverySchema = createInsertSchema(
  retellWebhookDeliveriesTable,
).omit({ receivedAt: true });
export type InsertRetellWebhookDelivery = z.infer<
  typeof insertRetellWebhookDeliverySchema
>;
export type RetellWebhookDelivery =
  typeof retellWebhookDeliveriesTable.$inferSelect;