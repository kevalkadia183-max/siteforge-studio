import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  receptionistsTable,
  receptionistConversationsTable,
  receptionistMessagesTable,
  receptionistAuditEventsTable,
  receptionistRateLimitsTable,
} from "@workspace/db";
import {
  GetWidgetConfigParams,
  GetWidgetConfigResponse,
  WidgetChatParams,
  WidgetChatBody,
  WidgetChatResponse,
  GetWidgetConversationMessagesParams,
  GetWidgetConversationMessagesHeader,
  GetWidgetConversationMessagesResponse,
} from "@workspace/api-zod";
import { newOpaqueId, newSecret, hashSecret } from "../lib/receptionist-auth";
import { statusAfterInboundActivity } from "../lib/receptionist-conversation-status";
import { generateReceptionistReply, type ChatTurn } from "../lib/receptionist-ai";

const router: IRouter = Router();

// Rate-limit config: 20 messages per 10-minute window per key
const rateLimitWindowMs = 10 * 60 * 1000;
const rateLimitMaxRequests = 20;

async function consumeWidgetQuota(
  key: string,
  maxRequests = rateLimitMaxRequests,
): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - rateLimitWindowMs);
  const keyHash = hashSecret(`widget:${key}`);

  const [entry] = await db
    .insert(receptionistRateLimitsTable)
    .values({
      keyHash,
      windowStartedAt: now,
      requestCount: 1,
    })
    .onConflictDoUpdate({
      target: receptionistRateLimitsTable.keyHash,
      set: {
        requestCount: sql`
          CASE
            WHEN ${receptionistRateLimitsTable.windowStartedAt} <= ${cutoff} THEN 1
            ELSE ${receptionistRateLimitsTable.requestCount} + 1
          END
        `,
        windowStartedAt: sql`
          CASE
            WHEN ${receptionistRateLimitsTable.windowStartedAt} <= ${cutoff} THEN ${now}
            ELSE ${receptionistRateLimitsTable.windowStartedAt}
          END
        `,
      },
    })
    .returning({ requestCount: receptionistRateLimitsTable.requestCount });

  return (entry?.requestCount ?? 1) <= maxRequests;
}

// Public widget traffic intentionally supports client sites on other origins.
// These routes never accept owner credentials or provider tokens.
router.use("/widget", (req, res, next): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-SiteForge-Session-Token",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// GET /widget/:receptionistId/config
router.get("/widget/:receptionistId/config", async (req, res): Promise<void> => {
  const params = GetWidgetConfigParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [receptionist] = await db
    .select()
    .from(receptionistsTable)
    .where(eq(receptionistsTable.id, params.data.receptionistId))
    .limit(1);

  if (!receptionist || !receptionist.enabled) {
    res.status(404).json({ error: "Receptionist not found or disabled." });
    return;
  }

  // Only return safe public fields — never expose prompts, keys, or integration details
  res.json(
    GetWidgetConfigResponse.parse({
      receptionistId: receptionist.id,
      enabled: receptionist.enabled,
      businessName: receptionist.businessName,
      assistantName: receptionist.assistantName,
      greeting: receptionist.greeting ?? null,
    }),
  );
});

// POST /widget/:receptionistId/chat
router.post("/widget/:receptionistId/chat", async (req, res): Promise<void> => {
  const params = WidgetChatParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = WidgetChatBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [receptionist] = await db
    .select()
    .from(receptionistsTable)
    .where(eq(receptionistsTable.id, params.data.receptionistId))
    .limit(1);

  if (!receptionist || !receptionist.enabled) {
    res.status(404).json({ error: "Receptionist not found or disabled." });
    return;
  }

  // Durable rate limiting: per tenant + IP and per tenant + session
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const tenantIpKey = `${receptionist.id}:ip:${ip}`;
  const withinIpLimit = await consumeWidgetQuota(tenantIpKey);
  if (!withinIpLimit) {
    res.status(429).json({ error: "Rate limit exceeded. Please wait before sending more messages." });
    return;
  }

  // Resolve or create conversation
  let conversationId: string;
  let sessionToken: string;
  let sessionTokenHash = "";
  let shouldCreateConversation = false;

  const providedToken = body.data.sessionToken;

  if (providedToken) {
    // Verify session token
    const tokenHash = hashSecret(providedToken);
    const tenantSessionKey = `${receptionist.id}:session:${providedToken}`;
    const withinSessionLimit = await consumeWidgetQuota(tenantSessionKey);
    if (!withinSessionLimit) {
      res.status(429).json({ error: "Rate limit exceeded for this session." });
      return;
    }

    const [existingConvo] = await db
      .select()
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.receptionistId, receptionist.id),
          eq(receptionistConversationsTable.sessionTokenHash, tokenHash),
          eq(receptionistConversationsTable.channel, "chat"),
        ),
      )
      .limit(1);

    if (!existingConvo) {
      res.status(404).json({ error: "Session not found. Please start a new conversation." });
      return;
    }

    conversationId = existingConvo.id;
    sessionToken = providedToken;
  } else {
    // First message: reserve a new conversation and session token. The
    // conversation is inserted atomically with the inbound message below.
    sessionToken = newSecret();
    sessionTokenHash = hashSecret(sessionToken);
    conversationId = newOpaqueId();
    shouldCreateConversation = true;

    // Also rate-limit new session
    const tenantSessionKey = `${receptionist.id}:session:${sessionToken}`;
    await consumeWidgetQuota(tenantSessionKey);
  }

  // Load conversation history (up to last 20 messages for context)
  const history = shouldCreateConversation
    ? []
    : await db
        .select()
        .from(receptionistMessagesTable)
        .where(
          and(
            eq(receptionistMessagesTable.receptionistId, receptionist.id),
            eq(receptionistMessagesTable.conversationId, conversationId),
          ),
        )
        .orderBy(receptionistMessagesTable.createdAt)
        .limit(20);

  const chatHistory: ChatTurn[] = history.map((m) => ({
    role: m.role as "user" | "assistant" | "owner",
    content: m.content,
  }));

  // Accept the inbound message and advance conversation freshness atomically.
  // Owners acting on an older inbox snapshot will now receive a 409 even while
  // AI generation is still in progress or later fails.
  const userMsgId = newOpaqueId();
  const userMsgContent = body.data.message;
  const inboundAcceptedAt = new Date();
  const inboundAccepted = await db.transaction(async (tx) => {
    let previousStatus: string | null = null;
    let acceptedStatus: string | null = null;

    if (shouldCreateConversation) {
      await tx.insert(receptionistConversationsTable).values({
        id: conversationId,
        receptionistId: receptionist.id,
        channel: "chat",
        sessionTokenHash,
        status: "open",
        updatedAt: inboundAcceptedAt,
      });
    } else {
      const [conversation] = await tx
        .select({
          id: receptionistConversationsTable.id,
          status: receptionistConversationsTable.status,
        })
        .from(receptionistConversationsTable)
        .where(
          and(
            eq(receptionistConversationsTable.id, conversationId),
            eq(
              receptionistConversationsTable.receptionistId,
              receptionist.id,
            ),
            eq(receptionistConversationsTable.channel, "chat"),
          ),
        )
        .limit(1)
        .for("update");

      if (!conversation) return false;

      acceptedStatus = statusAfterInboundActivity(conversation.status);
      if (acceptedStatus !== conversation.status) {
        previousStatus = conversation.status;
      }

      await tx
        .update(receptionistConversationsTable)
        .set({ status: acceptedStatus, updatedAt: inboundAcceptedAt })
        .where(eq(receptionistConversationsTable.id, conversation.id));
    }

    await tx.insert(receptionistMessagesTable).values({
      id: userMsgId,
      receptionistId: receptionist.id,
      conversationId,
      role: "user",
      content: userMsgContent,
    });

    if (previousStatus && acceptedStatus) {
      await tx.insert(receptionistAuditEventsTable).values({
        id: newOpaqueId(),
        receptionistId: receptionist.id,
        conversationId,
        messageId: userMsgId,
        eventType: "conversation_status_changed",
        metadata: {
          previousStatus,
          status: acceptedStatus,
          source: "widget_inbound",
        },
      });
    }

    return true;
  });

  if (!inboundAccepted) {
    res.status(404).json({
      error: "Session not found. Please start a new conversation.",
    });
    return;
  }

  // Generate AI reply
  let aiResult: { reply: string; escalate: boolean };
  try {
    aiResult = await generateReceptionistReply(
      receptionist,
      chatHistory,
      userMsgContent,
    );
  } catch (err) {
    req.log.error({ error: err }, "AI receptionist model failure");
    // On model failure return explicit 503 — never fake an answer
    res.status(503).json({
      error:
        "The AI assistant is temporarily unavailable. Please try again shortly or contact us directly.",
    });
    return;
  }

  // Persist the assistant reply, status transition, and audit event atomically.
  const assistantMsgId = newOpaqueId();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(receptionistMessagesTable).values({
      id: assistantMsgId,
      receptionistId: receptionist.id,
      conversationId,
      role: "assistant",
      content: aiResult.reply,
      metadata: aiResult.escalate ? { escalated: true } : undefined,
    });

    await tx
      .update(receptionistConversationsTable)
      .set({
        updatedAt: now,
        ...(aiResult.escalate ? { status: "escalated" } : {}),
      })
      .where(
        and(
          eq(receptionistConversationsTable.id, conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionist.id),
        ),
      );

    await tx.insert(receptionistAuditEventsTable).values({
      id: newOpaqueId(),
      receptionistId: receptionist.id,
      conversationId,
      messageId: assistantMsgId,
      eventType: aiResult.escalate ? "chat_escalation" : "chat_reply",
      metadata: { escalate: aiResult.escalate },
    });
  });

  res.json(
    WidgetChatResponse.parse({
      sessionToken,
      conversationId,
      reply: aiResult.reply,
      escalate: aiResult.escalate,
      escalationContact: aiResult.escalate
        ? (receptionist.escalationContact ?? receptionist.businessEmail ?? null)
        : null,
    }),
  );
});

// GET /widget/:receptionistId/conversations/:conversationId/messages
router.get(
  "/widget/:receptionistId/conversations/:conversationId/messages",
  async (req, res): Promise<void> => {
    const params = GetWidgetConversationMessagesParams.safeParse(req.params);
    const header = GetWidgetConversationMessagesHeader.safeParse({
      "X-SiteForge-Session-Token":
        req.get("X-SiteForge-Session-Token") ?? "",
    });
    if (!params.success || !header.success) {
      res.status(400).json({ error: "Invalid chat session." });
      return;
    }

    const allowed = await consumeWidgetQuota(
      `${params.data.receptionistId}:poll:${header.data["X-SiteForge-Session-Token"]}`,
      180,
    );
    if (!allowed) {
      res.status(429).json({ error: "Rate limit exceeded for this session." });
      return;
    }

    const [conversation] = await db
      .select({ id: receptionistConversationsTable.id })
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.id, params.data.conversationId),
          eq(
            receptionistConversationsTable.receptionistId,
            params.data.receptionistId,
          ),
          eq(receptionistConversationsTable.channel, "chat"),
          eq(
            receptionistConversationsTable.sessionTokenHash,
            hashSecret(header.data["X-SiteForge-Session-Token"]),
          ),
        ),
      )
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Chat session not found." });
      return;
    }

    const messages = await db
      .select({
        messageId: receptionistMessagesTable.id,
        role: receptionistMessagesTable.role,
        content: receptionistMessagesTable.content,
        createdAt: receptionistMessagesTable.createdAt,
      })
      .from(receptionistMessagesTable)
      .where(
        and(
          eq(
            receptionistMessagesTable.receptionistId,
            params.data.receptionistId,
          ),
          eq(receptionistMessagesTable.conversationId, conversation.id),
        ),
      )
      .orderBy(receptionistMessagesTable.createdAt)
      .limit(100);

    res.json(
      GetWidgetConversationMessagesResponse.parse({
        conversationId: conversation.id,
        messages,
      }),
    );
  },
);

export default router;
