import { and, eq } from "drizzle-orm";
import {
  db,
  receptionistAuditEventsTable,
  receptionistConversationsTable,
  receptionistMessagesTable,
  retellWebhookDeliveriesTable,
} from "@workspace/db";
import { newOpaqueId } from "./receptionist-auth";
import {
  ingestEndedRetellCall,
  type RetellCallIngestionInput,
  type RetellIngestionTransaction,
} from "./retell-call-ingestion";

export function importEndedRetellCall(input: RetellCallIngestionInput) {
  return ingestEndedRetellCall(input, {
    newId: newOpaqueId,
    now: () => new Date(),
    transaction: (work) =>
      db.transaction(async (databaseTransaction) => {
        const transaction: RetellIngestionTransaction = {
          async claimWebhookDelivery(claim) {
            const [inserted] = await databaseTransaction
              .insert(retellWebhookDeliveriesTable)
              .values(claim)
              .onConflictDoNothing()
              .returning({ id: retellWebhookDeliveriesTable.id });
            return Boolean(inserted);
          },
          async createConversation(conversation) {
            const [inserted] = await databaseTransaction
              .insert(receptionistConversationsTable)
              .values(conversation)
              .onConflictDoNothing()
              .returning({ id: receptionistConversationsTable.id });
            return Boolean(inserted);
          },
          async findConversationId(receptionistId, callId) {
            const [conversation] = await databaseTransaction
              .select({ id: receptionistConversationsTable.id })
              .from(receptionistConversationsTable)
              .where(
                and(
                  eq(
                    receptionistConversationsTable.receptionistId,
                    receptionistId,
                  ),
                  eq(receptionistConversationsTable.channel, "call"),
                  eq(receptionistConversationsTable.externalId, callId),
                ),
              )
              .limit(1);
            return conversation?.id ?? null;
          },
          async createMessage(message) {
            const [inserted] = await databaseTransaction
              .insert(receptionistMessagesTable)
              .values(message)
              .onConflictDoNothing()
              .returning({ id: receptionistMessagesTable.id });
            return Boolean(inserted);
          },
          async createAuditEvent(event) {
            await databaseTransaction
              .insert(receptionistAuditEventsTable)
              .values(event);
          },
        };
        return work(transaction);
      }),
  });
}