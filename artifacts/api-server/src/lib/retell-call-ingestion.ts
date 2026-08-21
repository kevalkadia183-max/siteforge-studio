import type { RetellCall } from "./retell-webhook";

export type RetellCallIngestionInput = {
  receptionistId: string;
  call: RetellCall;
  source: "manual_sync" | "webhook";
  webhook?: {
    deliveryKey: string;
    payloadHash: string;
    signatureTimestamp: number;
  };
};

export type RetellCallIngestionOutcome = {
  kind: "imported" | "already_imported" | "replay";
  conversationCreated: boolean;
  messagesCreated: number;
};

export type RetellWebhookDeliveryClaim = {
  id: string;
  provider: "retell";
  deliveryKey: string;
  receptionistId: string;
  eventType: "call_ended";
  callId: string;
  payloadHash: string;
  signatureTimestamp: number;
};

export type RetellConversationCreate = {
  id: string;
  receptionistId: string;
  channel: "call";
  externalId: string;
  subject: string;
  status: "closed";
};

export type RetellMessageCreate = {
  id: string;
  receptionistId: string;
  conversationId: string;
  role: "assistant" | "user" | "system";
  content: string;
  externalMessageId: string;
  metadata?: Record<string, unknown>;
};

export type RetellAuditCreate = {
  id: string;
  receptionistId: string;
  conversationId?: string;
  eventType:
    | "retell_call_synced"
    | "retell_call_webhook_ingested"
    | "retell_webhook_replay_rejected";
  metadata: Record<string, unknown>;
};

export type RetellIngestionTransaction = {
  claimWebhookDelivery(claim: RetellWebhookDeliveryClaim): Promise<boolean>;
  createConversation(conversation: RetellConversationCreate): Promise<boolean>;
  findConversationId(
    receptionistId: string,
    callId: string,
  ): Promise<string | null>;
  createMessage(message: RetellMessageCreate): Promise<boolean>;
  createAuditEvent(event: RetellAuditCreate): Promise<void>;
};

export type RetellIngestionDependencies = {
  newId(): string;
  now(): Date;
  transaction<T>(
    work: (tx: RetellIngestionTransaction) => Promise<T>,
  ): Promise<T>;
};

export async function ingestEndedRetellCall(
  input: RetellCallIngestionInput,
  dependencies: RetellIngestionDependencies,
): Promise<RetellCallIngestionOutcome> {
  if (input.source === "webhook" && !input.webhook) {
    throw new Error("Webhook delivery metadata is required.");
  }
  if (input.source === "manual_sync" && input.webhook) {
    throw new Error("Manual sync must not include webhook delivery metadata.");
  }

  const callId = input.call.call_id;
  const candidateConversationId = dependencies.newId();

  return dependencies.transaction(async (tx) => {
    if (input.webhook) {
      const claimed = await tx.claimWebhookDelivery({
        id: dependencies.newId(),
        provider: "retell",
        deliveryKey: input.webhook.deliveryKey,
        receptionistId: input.receptionistId,
        eventType: "call_ended",
        callId,
        payloadHash: input.webhook.payloadHash,
        signatureTimestamp: input.webhook.signatureTimestamp,
      });
      if (!claimed) {
        await tx.createAuditEvent({
          id: dependencies.newId(),
          receptionistId: input.receptionistId,
          eventType: "retell_webhook_replay_rejected",
          metadata: {
            callId,
            deliveryKey: input.webhook.deliveryKey,
            payloadHash: input.webhook.payloadHash,
          },
        });
        return {
          kind: "replay",
          conversationCreated: false,
          messagesCreated: 0,
        };
      }
    }

    const startDate = safeDate(input.call.start_timestamp, dependencies.now());
    const conversationCreated = await tx.createConversation({
      id: candidateConversationId,
      receptionistId: input.receptionistId,
      channel: "call",
      externalId: callId,
      subject: `Call ${startDate.toISOString()}`,
      status: "closed",
    });

    let conversationId = candidateConversationId;
    let messagesCreated = 0;
    if (conversationCreated) {
      const transcript = input.call.transcript_object ?? [];
      for (let i = 0; i < transcript.length; i++) {
        const utterance = transcript[i];
        if (!utterance) continue;

        const role =
          utterance.role === "agent"
            ? "assistant"
            : utterance.role === "user"
              ? "user"
              : "system";
        const metadata =
          i === 0 && input.call.recording_url
            ? {
                recording_url_ref: input.call.recording_url,
                call_analysis: input.call.call_analysis,
              }
            : undefined;
        const created = await tx.createMessage({
          id: dependencies.newId(),
          receptionistId: input.receptionistId,
          conversationId,
          role,
          content: utterance.content,
          externalMessageId: `${callId}:${i}`,
          metadata,
        });
        if (created) messagesCreated++;
      }
    } else {
      const existingConversationId = await tx.findConversationId(
        input.receptionistId,
        callId,
      );
      if (!existingConversationId) {
        throw new Error(
          "Retell call conflicted without an existing conversation.",
        );
      }
      conversationId = existingConversationId;
    }

    if (input.source === "manual_sync" && !conversationCreated) {
      return {
        kind: "already_imported",
        conversationCreated: false,
        messagesCreated: 0,
      };
    }

    await tx.createAuditEvent({
      id: dependencies.newId(),
      receptionistId: input.receptionistId,
      conversationId,
      eventType:
        input.source === "webhook"
          ? "retell_call_webhook_ingested"
          : "retell_call_synced",
      metadata: {
        callId,
        callStatus: input.call.call_status,
        conversationCreated,
        ...(input.webhook
          ? { deliveryKey: input.webhook.deliveryKey }
          : undefined),
      },
    });

    return {
      kind: conversationCreated ? "imported" : "already_imported",
      conversationCreated,
      messagesCreated,
    };
  });
}

function safeDate(timestamp: number | undefined, fallback: Date): Date {
  if (timestamp === undefined) return fallback;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? fallback : date;
}