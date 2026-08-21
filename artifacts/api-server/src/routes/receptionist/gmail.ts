import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  db,
  receptionistConversationsTable,
  receptionistMessagesTable,
  receptionistAuditEventsTable,
} from "@workspace/db";
import {
  SyncGmailParams,
  SyncGmailResponse,
  ApproveEmailDraftParams,
  ApproveEmailDraftResponse,
  RecoverEmailDraftParams,
  RecoverEmailDraftResponse,
  RejectEmailDraftParams,
  RejectEmailDraftResponse,
} from "@workspace/api-zod";
import { newOpaqueId } from "../../lib/receptionist-auth";
import { verifyReceptionistOwner } from "../../lib/receptionist-owner-auth";
import { recordGmailInboundConversationActivity } from "../../lib/receptionist-conversation-transitions";
import { generateEmailReplySuggestion } from "../../lib/receptionist-ai";
import {
  approveGmailDraft,
  recoverGmailDraft,
  type GmailDraftApprovalDependencies,
  type GmailDraftApprovalMessage,
} from "../../lib/gmail-draft-approval";
import {
  withGmailDraftOperationLock,
  type GmailDraftOperationDatabase,
} from "../../lib/gmail-draft-operation-lock";

const router: IRouter = Router();
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const maxInboundBodyLength = 20_000;

type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
};

function extractEmail(value: string): string | null {
  return value.match(emailPattern)?.[0] ?? null;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function htmlToPlainText(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractMessageBody(payload: GmailMessagePart | undefined): {
  body: string | null;
  reason: "complete" | "unavailable" | "too_large";
} {
  if (!payload) return { body: null, reason: "unavailable" };

  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  const visit = (part: GmailMessagePart): void => {
    if (part.filename || part.body?.attachmentId) return;

    if (part.body?.data) {
      try {
        const decoded = decodeBase64Url(part.body.data);
        if (part.mimeType?.toLowerCase() === "text/html") {
          htmlParts.push(htmlToPlainText(decoded));
        } else if (
          !part.mimeType ||
          part.mimeType.toLowerCase() === "text/plain"
        ) {
          plainParts.push(decoded.trim());
        }
      } catch {
        // Malformed MIME data must fail closed rather than reach the model.
      }
    }

    for (const child of part.parts ?? []) visit(child);
  };

  visit(payload);
  const body = (
    plainParts.find(Boolean) ??
    htmlParts.find(Boolean) ??
    ""
  ).trim();
  if (!body) return { body: null, reason: "unavailable" };
  if (body.length > maxInboundBodyLength) {
    return { body: null, reason: "too_large" };
  }
  return { body, reason: "complete" };
}

function getMessageHeader(
  message: GmailMessage,
  headerName: string,
): string | null {
  const header = message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === headerName.toLowerCase(),
  );
  return header?.value?.trim() || null;
}

async function fetchLatestInboxMessage(
  connectors: ReplitConnectors,
  threadId: string,
): Promise<GmailMessage | null> {
  const response = await connectors.proxy(
    "google-mail",
    `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    { method: "GET" },
  );
  if (!response.ok) return null;

  const data = (await response.json()) as { messages?: GmailMessage[] };
  return (
    (data.messages ?? [])
      .filter((message) => {
        const labels = new Set(message.labelIds ?? []);
        return (
          labels.has("INBOX") && !labels.has("SENT") && !labels.has("DRAFT")
        );
      })
      .sort(
        (left, right) =>
          Number(left.internalDate ?? 0) - Number(right.internalDate ?? 0),
      )
      .at(-1) ?? null
  );
}

function createGmailApprovalDependencies(
  database: GmailDraftOperationDatabase,
  message: GmailDraftApprovalMessage,
  receptionistId: string,
  log: Pick<Request["log"], "warn" | "error">,
): GmailDraftApprovalDependencies {
  const reconciliationTokenCondition = (token: string) =>
    sql`${receptionistMessagesTable.metadata} ->> 'draftReconciliationToken' = ${token}`;

  return {
    runExclusive: async (messageId, operation) =>
      withGmailDraftOperationLock(
        messageId,
        (scopedDatabase) =>
          operation(
            createGmailApprovalDependencies(
              scopedDatabase,
              message,
              receptionistId,
              log,
            ),
          ),
        (error) =>
          log.error(
            { error: String(error), messageId },
            "Failed to release Gmail draft operation lock",
          ),
      ),
    createConnector: () => new ReplitConnectors(),
    getConversation: async () => {
      const [conversation] = await database
        .select()
        .from(receptionistConversationsTable)
        .where(
          and(
            eq(receptionistConversationsTable.id, message.conversationId),
            eq(receptionistConversationsTable.receptionistId, receptionistId),
          ),
        )
        .limit(1);
      return conversation ?? null;
    },
    claimApproval: async ({ metadata }) => {
      const [claimedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "approving", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, "pending"),
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(claimedMessage);
    },
    claimReconciliation: async ({ metadata }) => {
      const [claimedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "reconciling", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, "approving"),
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(claimedMessage);
    },
    claimRecovery: async ({ metadata, previousReconciliationToken }) => {
      const previousTokenCondition =
        previousReconciliationToken === null
          ? sql`${receptionistMessagesTable.metadata} ->> 'draftReconciliationToken' is null`
          : reconciliationTokenCondition(previousReconciliationToken);
      const [claimedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "reconciling", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, "reconciling"),
            previousTokenCondition,
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(claimedMessage);
    },
    releaseReconciliation: async ({ metadata, reconciliationToken }) => {
      const [releasedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "approving", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, "reconciling"),
            reconciliationTokenCondition(reconciliationToken),
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(releasedMessage);
    },
    markApproved: async ({ metadata, expectedState, reconciliationToken }) => {
      const ownershipCondition =
        expectedState !== "reconciling"
          ? undefined
          : reconciliationToken
            ? reconciliationTokenCondition(reconciliationToken)
            : sql`false`;
      const [updatedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "approved", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, expectedState),
            ownershipCondition,
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(updatedMessage);
    },
    markRetryReady: async ({ metadata, reconciliationToken }) => {
      const [updatedMessage] = await database
        .update(receptionistMessagesTable)
        .set({ approvalState: "pending", metadata })
        .where(
          and(
            eq(receptionistMessagesTable.id, message.id),
            eq(receptionistMessagesTable.receptionistId, receptionistId),
            eq(receptionistMessagesTable.approvalState, "reconciling"),
            reconciliationTokenCondition(reconciliationToken),
          ),
        )
        .returning({ id: receptionistMessagesTable.id });
      return Boolean(updatedMessage);
    },
    audit: async ({ eventType, metadata }) => {
      await database.insert(receptionistAuditEventsTable).values({
        id: newOpaqueId(),
        receptionistId,
        conversationId: message.conversationId,
        messageId: message.id,
        eventType,
        metadata,
      });
    },
    now: () => new Date(),
    warn: (message, details) => log.warn(details, message),
    error: (message, details) => log.error(details, message),
  };
}

// Owner auth is now handled by the shared verifyReceptionistOwner helper.

// POST /receptionist/:receptionistId/gmail/sync
router.post(
  "/receptionist/:receptionistId/gmail/sync",
  async (req, res): Promise<void> => {
    const params = SyncGmailParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(
      req,
      res,
      params.data.receptionistId,
    );
    if (!receptionist) return;

    // Create new connector instance per request — never cache
    const connectors = new ReplitConnectors();

    let threadsChecked = 0;
    let newMessages = 0;
    let suggestionsCreated = 0;

    try {
      // Use Gmail's fused search endpoint so one request returns hydrated threads.
      const searchResp = await connectors.proxy(
        "google-mail",
        "/gmail/v1/users/me/threads:search?q=in%3Ainbox%20newer_than%3A7d%20-in%3Asent%20-category%3Apromotions%20-category%3Asocial&pageSize=10&view=THREAD_VIEW_MINIMAL",
        { method: "GET" },
      );

      if (!searchResp.ok) {
        req.log.warn(
          { status: searchResp.status },
          "Gmail threads search failed",
        );
        res.status(502).json({ error: "Gmail connector returned an error." });
        return;
      }

      const searchData = (await searchResp.json()) as {
        threads?: Array<{ id: string; error?: unknown }>;
      };
      const threads = searchData.threads ?? [];
      threadsChecked = threads.length;

      // Reuse existing conversations so later inbound messages in a thread can sync.
      const existingConvos = await db
        .select({
          id: receptionistConversationsTable.id,
          externalId: receptionistConversationsTable.externalId,
        })
        .from(receptionistConversationsTable)
        .where(
          and(
            eq(receptionistConversationsTable.receptionistId, receptionist.id),
            eq(receptionistConversationsTable.channel, "email"),
          ),
        );
      const conversationByThreadId = new Map(
        existingConvos
          .filter(
            (
              conversation,
            ): conversation is { id: string; externalId: string } =>
              Boolean(conversation.externalId),
          )
          .map((conversation) => [conversation.externalId, conversation.id]),
      );
      const existingExternalMessages = await db
        .select({
          externalMessageId: receptionistMessagesTable.externalMessageId,
        })
        .from(receptionistMessagesTable)
        .where(eq(receptionistMessagesTable.receptionistId, receptionist.id));
      const knownMessageIds = new Set(
        existingExternalMessages
          .map((message) => message.externalMessageId)
          .filter((id): id is string => Boolean(id)),
      );

      for (const thread of threads) {
        if (suggestionsCreated >= 5) break;
        if (thread.error) {
          req.log.warn(
            { threadId: thread.id },
            "Gmail returned an incomplete thread",
          );
          continue;
        }
        const latestMessage = await fetchLatestInboxMessage(
          connectors,
          thread.id,
        );
        if (!latestMessage || knownMessageIds.has(latestMessage.id)) continue;

        const subject =
          getMessageHeader(latestMessage, "Subject") || "(No subject)";
        const from = getMessageHeader(latestMessage, "From") || "Unknown";
        const recipientEmail = extractEmail(from);
        const snippet = latestMessage.snippet || "";
        const bodyResult = extractMessageBody(latestMessage.payload);
        const fullBody = bodyResult.body;

        let convoId = conversationByThreadId.get(thread.id);
        if (!convoId) {
          convoId = newOpaqueId();
          const [insertedConversation] = await db
            .insert(receptionistConversationsTable)
            .values({
              id: convoId,
              receptionistId: receptionist.id,
              channel: "email",
              externalId: thread.id,
              subject,
              status: "open",
            })
            .onConflictDoNothing()
            .returning({ id: receptionistConversationsTable.id });
          if (!insertedConversation) {
            const [existingConversation] = await db
              .select({ id: receptionistConversationsTable.id })
              .from(receptionistConversationsTable)
              .where(
                and(
                  eq(
                    receptionistConversationsTable.receptionistId,
                    receptionist.id,
                  ),
                  eq(receptionistConversationsTable.channel, "email"),
                  eq(receptionistConversationsTable.externalId, thread.id),
                ),
              )
              .limit(1);
            if (!existingConversation) continue;
            convoId = existingConversation.id;
          }
          conversationByThreadId.set(thread.id, convoId);
        } else {
          const existingConvoId = convoId;
          await recordGmailInboundConversationActivity({
            receptionistId: receptionist.id,
            conversationId: existingConvoId,
            subject,
          });
        }

        // Store the readable message for owner review. Never draft from a snippet:
        // Gmail snippets are truncated and can omit material request details.
        const inboundMsgId = newOpaqueId();
        const inboundSummary = `From: ${from}\nSubject: ${subject}\n\n${
          fullBody ??
          `${snippet}\n\n[${
            bodyResult.reason === "too_large"
              ? "Full message body exceeds the safe processing limit"
              : "Full message body unavailable"
          }. No AI draft was created.]`
        }`;
        const [insertedInboundMessage] = await db
          .insert(receptionistMessagesTable)
          .values({
            id: inboundMsgId,
            receptionistId: receptionist.id,
            conversationId: convoId,
            role: "user",
            content: inboundSummary,
            externalMessageId: latestMessage.id,
            metadata: {
              threadId: thread.id,
              from,
              subject,
              recipientEmail,
              bodySource: bodyResult.reason,
            },
          })
          .onConflictDoNothing()
          .returning({ id: receptionistMessagesTable.id });
        if (!insertedInboundMessage) {
          knownMessageIds.add(latestMessage.id);
          continue;
        }
        knownMessageIds.add(latestMessage.id);
        newMessages++;

        // Generate only from a complete message body. Missing/unsupported MIME
        // content remains visible to the owner but fails closed for AI drafting.
        if (fullBody) {
          try {
            const suggestion = await generateEmailReplySuggestion(
              receptionist,
              `From: ${from}\nSubject: ${subject}\n\n${fullBody}`,
            );

            if (suggestion) {
              const suggestionMsgId = newOpaqueId();
              await db.insert(receptionistMessagesTable).values({
                id: suggestionMsgId,
                receptionistId: receptionist.id,
                conversationId: convoId,
                role: "assistant",
                content: suggestion,
                approvalState: "pending",
                metadata: {
                  threadId: thread.id,
                  subject,
                  recipientEmail,
                },
              });
              suggestionsCreated++;

              await db.insert(receptionistAuditEventsTable).values({
                id: newOpaqueId(),
                receptionistId: receptionist.id,
                conversationId: convoId,
                messageId: suggestionMsgId,
                eventType: "email_suggestion_created",
              });
            }
          } catch (aiErr) {
            req.log.warn({ error: aiErr }, "AI email suggestion failed");
          }
        } else {
          await db.insert(receptionistAuditEventsTable).values({
            id: newOpaqueId(),
            receptionistId: receptionist.id,
            conversationId: convoId,
            messageId: inboundMsgId,
            eventType: "email_suggestion_skipped",
            metadata: { reason: bodyResult.reason },
          });
        }

        await db.insert(receptionistAuditEventsTable).values({
          id: newOpaqueId(),
          receptionistId: receptionist.id,
          conversationId: convoId,
          eventType: "gmail_thread_synced",
          metadata: { threadId: thread.id, subject },
        });
      }
    } catch (err) {
      req.log.error({ error: err }, "Gmail sync error");
      res.status(502).json({ error: "Failed to sync Gmail inbox." });
      return;
    }

    res.json(
      SyncGmailResponse.parse({
        threadsChecked,
        newMessages,
        suggestionsCreated,
      }),
    );
  },
);

// POST /receptionist/:receptionistId/gmail/messages/:messageId/approve
router.post(
  "/receptionist/:receptionistId/gmail/messages/:messageId/approve",
  async (req, res): Promise<void> => {
    const params = ApproveEmailDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(
      req,
      res,
      params.data.receptionistId,
    );
    if (!receptionist) return;

    // Find the AI suggestion message. Approval is claimed atomically below.
    const [message] = await db
      .select()
      .from(receptionistMessagesTable)
      .where(
        and(
          eq(receptionistMessagesTable.id, params.data.messageId),
          eq(receptionistMessagesTable.receptionistId, receptionist.id),
        ),
      )
      .limit(1);

    if (!message) {
      res.status(404).json({ error: "Message not found." });
      return;
    }
    const outcome = await approveGmailDraft(
      message,
      createGmailApprovalDependencies(db, message, receptionist.id, req.log),
    );

    if (outcome.kind === "error") {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    res.json(
      ApproveEmailDraftResponse.parse({
        messageId: message.id,
        approvalState: "approved",
        gmailDraftId: outcome.gmailDraftId,
      }),
    );
  },
);

// POST /receptionist/:receptionistId/gmail/messages/:messageId/recover
router.post(
  "/receptionist/:receptionistId/gmail/messages/:messageId/recover",
  async (req, res): Promise<void> => {
    const params = RecoverEmailDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(
      req,
      res,
      params.data.receptionistId,
    );
    if (!receptionist) return;

    const [message] = await db
      .select()
      .from(receptionistMessagesTable)
      .where(
        and(
          eq(receptionistMessagesTable.id, params.data.messageId),
          eq(receptionistMessagesTable.receptionistId, receptionist.id),
        ),
      )
      .limit(1);

    if (!message) {
      res.status(404).json({ error: "Message not found." });
      return;
    }

    const outcome = await recoverGmailDraft(
      message,
      createGmailApprovalDependencies(db, message, receptionist.id, req.log),
    );

    if (outcome.kind === "error") {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }

    res.json(
      RecoverEmailDraftResponse.parse({
        messageId: params.data.messageId,
        approvalState: "approved",
        gmailDraftId: outcome.gmailDraftId,
      }),
    );
  },
);

// POST /receptionist/:receptionistId/gmail/messages/:messageId/reject
router.post(
  "/receptionist/:receptionistId/gmail/messages/:messageId/reject",
  async (req, res): Promise<void> => {
    const params = RejectEmailDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(
      req,
      res,
      params.data.receptionistId,
    );
    if (!receptionist) return;

    const [message] = await db
      .select()
      .from(receptionistMessagesTable)
      .where(
        and(
          eq(receptionistMessagesTable.id, params.data.messageId),
          eq(receptionistMessagesTable.receptionistId, receptionist.id),
          eq(receptionistMessagesTable.approvalState, "pending"),
        ),
      )
      .limit(1);

    if (!message) {
      res.status(404).json({ error: "Pending message not found." });
      return;
    }

    await db
      .update(receptionistMessagesTable)
      .set({ approvalState: "rejected" })
      .where(eq(receptionistMessagesTable.id, message.id));

    await db.insert(receptionistAuditEventsTable).values({
      id: newOpaqueId(),
      receptionistId: receptionist.id,
      conversationId: message.conversationId,
      messageId: message.id,
      eventType: "email_draft_rejected",
    });

    res.json(
      RejectEmailDraftResponse.parse({
        messageId: message.id,
        approvalState: "rejected",
        gmailDraftId: null,
      }),
    );
  },
);

export default router;
