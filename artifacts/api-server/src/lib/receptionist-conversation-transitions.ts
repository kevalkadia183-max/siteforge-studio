import { and, eq } from "drizzle-orm";
import {
  db,
  receptionistAuditEventsTable,
  receptionistConversationsTable,
} from "@workspace/db";
import { newOpaqueId } from "./receptionist-auth";
import {
  conversationVersionMatches,
  statusAfterInboundActivity,
} from "./receptionist-conversation-status";

type ConversationStatus = "open" | "closed" | "escalated";

type TransitionOptions = {
  changedAt?: Date;
  newAuditEventId?: () => string;
};

export async function updateConversationStatus({
  receptionistId,
  conversationId,
  status,
  expectedUpdatedAt,
  changedAt = new Date(),
  newAuditEventId = newOpaqueId,
}: {
  receptionistId: string;
  conversationId: string;
  status: ConversationStatus;
  expectedUpdatedAt: Date;
} & TransitionOptions) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.id, conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionistId),
        ),
      )
      .limit(1)
      .for("update");

    if (!conversation) return { kind: "not_found" } as const;

    if (
      !conversationVersionMatches(
        conversation.updatedAt,
        expectedUpdatedAt,
      )
    ) {
      return { kind: "conflict" } as const;
    }

    if (conversation.status === status) {
      return { kind: "updated", conversation } as const;
    }

    const [changedConversation] = await tx
      .update(receptionistConversationsTable)
      .set({ status, updatedAt: changedAt })
      .where(
        and(
          eq(receptionistConversationsTable.id, conversation.id),
          eq(receptionistConversationsTable.receptionistId, receptionistId),
        ),
      )
      .returning();

    if (!changedConversation) return { kind: "not_found" } as const;

    await tx.insert(receptionistAuditEventsTable).values({
      id: newAuditEventId(),
      receptionistId,
      conversationId: conversation.id,
      eventType: "conversation_status_changed",
      metadata: {
        previousStatus: conversation.status,
        status,
      },
    });

    return { kind: "updated", conversation: changedConversation } as const;
  });
}

export async function recordGmailInboundConversationActivity({
  receptionistId,
  conversationId,
  subject,
  changedAt = new Date(),
  newAuditEventId = newOpaqueId,
}: {
  receptionistId: string;
  conversationId: string;
  subject: string;
} & TransitionOptions) {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select()
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.id, conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionistId),
        ),
      )
      .limit(1)
      .for("update");

    if (!conversation) return { kind: "not_found" } as const;

    const status = statusAfterInboundActivity(conversation.status);
    const [changedConversation] = await tx
      .update(receptionistConversationsTable)
      .set({ subject, status, updatedAt: changedAt })
      .where(
        and(
          eq(receptionistConversationsTable.id, conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionistId),
        ),
      )
      .returning();

    if (!changedConversation) return { kind: "not_found" } as const;

    if (status !== conversation.status) {
      await tx.insert(receptionistAuditEventsTable).values({
        id: newAuditEventId(),
        receptionistId,
        conversationId,
        eventType: "conversation_status_changed",
        metadata: {
          previousStatus: conversation.status,
          status,
          source: "gmail_inbound",
        },
      });
    }

    return { kind: "updated", conversation: changedConversation } as const;
  });
}