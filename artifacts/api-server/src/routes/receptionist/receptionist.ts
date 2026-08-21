import { and, count, desc, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import {
  db,
  receptionistsTable,
  receptionistConversationsTable,
  receptionistMessagesTable,
  receptionistAuditEventsTable,
} from "@workspace/db";
import {
  CreateReceptionistBody,
  CreateReceptionistHeader,
  CreateReceptionistResponse,
  GetReceptionistSettingsParams,
  GetReceptionistSettingsResponse,
  UpdateReceptionistSettingsParams,
  UpdateReceptionistSettingsBody,
  UpdateReceptionistSettingsResponse,
  ListReceptionistConversationsParams,
  ListReceptionistConversationsResponse,
  GetConversationParams,
  GetConversationResponse,
  OwnerReplyParams,
  OwnerReplyBody,
  OwnerReplyResponse,
  UpdateConversationStatusParams,
  UpdateConversationStatusBody,
  UpdateConversationStatusResponse,
} from "@workspace/api-zod";
import { newOpaqueId, newSecret, hashSecret } from "../../lib/receptionist-auth";
import { updateConversationStatus } from "../../lib/receptionist-conversation-transitions";
import { PILOT_RETELL_AGENT_ID } from "../../lib/receptionist-retell";
import { verifyReceptionistOwner } from "../../lib/receptionist-owner-auth";
import { jitUpsertUser } from "../../middlewares/requireAuth";

const router: IRouter = Router();
const PRIMARY_PILOT_SLOT = "primary";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function hasValidSetupKey(req: Request): "valid" | "invalid" | "unconfigured" {
  const expected = process.env.SITEFORGE_PILOT_SETUP_KEY;
  if (!expected) return "unconfigured";
  const header = CreateReceptionistHeader.safeParse({
    "X-SiteForge-Setup-Key": req.get("X-SiteForge-Setup-Key") ?? "",
  });
  if (!header.success) return "invalid";
  const submitted = header.data["X-SiteForge-Setup-Key"];
  if (!submitted) return "invalid";
  const submittedHash = Buffer.from(
    hashSecret(submitted),
    "hex",
  );
  const expectedHash = Buffer.from(hashSecret(expected), "hex");
  return timingSafeEqual(submittedHash, expectedHash) ? "valid" : "invalid";
}

// Owner auth is handled by the shared verifyReceptionistOwner helper which
// accepts either X-SiteForge-Owner-Key or a Clerk session that owns a website
// linked to the receptionistId. This replaces the previous local verifyOwner.

// POST /receptionist — create
router.post("/receptionist", async (req, res): Promise<void> => {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId ?? null;

  // Signed-in SiteForge owners are authorized by their verified Clerk session.
  // Keep the setup-key path only for legacy/API-only pilot provisioning.
  if (!clerkUserId) {
    const setupKeyStatus = hasValidSetupKey(req);
    if (setupKeyStatus === "unconfigured") {
      res.status(503).json({ error: "Pilot provisioning is not configured." });
      return;
    }
    if (setupKeyStatus === "invalid") {
      res.status(401).json({
        error: "Sign in to SiteForge or provide a valid pilot setup key.",
      });
      return;
    }
  }

  const body = CreateReceptionistBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const id = newOpaqueId();
  const ownerKey = newSecret();
  const ownerKeyHash = hashSecret(ownerKey);

  // If there is an authenticated Clerk session, JIT-upsert the user row first
  // so the FK constraint on receptionists.owner_id is satisfiable, then record
  // ownership. This prevents FK violations when the user row doesn't exist yet.
  if (clerkUserId) {
    const clerkEmail =
      typeof (auth.sessionClaims as Record<string, unknown> | null | undefined)?.["email"] === "string"
        ? (auth.sessionClaims as Record<string, unknown>)["email"] as string
        : null;
    await jitUpsertUser(clerkUserId, clerkEmail);
  }

  try {
    await db.insert(receptionistsTable).values({
      id,
      // The named slot remains only for the legacy single-pilot path. Signed-in
      // accounts receive independent, owner-scoped receptionists.
      pilotSlot: clerkUserId ? null : PRIMARY_PILOT_SLOT,
      ownerKeyHash,
      // Bind Clerk user as owner immediately if authenticated; null for API-key-only creation
      ownerId: clerkUserId ?? null,
      businessName: body.data.businessName,
      businessEmail: body.data.businessEmail ?? null,
      assistantName: body.data.assistantName ?? "Assistant",
      retellAgentId: PILOT_RETELL_AGENT_ID,
      enabled: true,
    });
  } catch (error) {
    if (!clerkUserId && isUniqueViolation(error)) {
      res.status(409).json({
        error:
          "This SiteForge deployment already has its one pilot receptionist.",
      });
      return;
    }
    throw error;
  }

  await db.insert(receptionistAuditEventsTable).values({
    id: newOpaqueId(),
    receptionistId: id,
    eventType: "receptionist_created",
    metadata: { businessName: body.data.businessName },
  });

  req.log.info({ receptionistId: id }, "Receptionist created");

  res.status(201).json(
    CreateReceptionistResponse.parse({ receptionistId: id, ownerKey }),
  );
});

// GET /receptionist/:receptionistId/settings
router.get(
  "/receptionist/:receptionistId/settings",
  async (req, res): Promise<void> => {
    const params = GetReceptionistSettingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    res.json(
      GetReceptionistSettingsResponse.parse({
        receptionistId: receptionist.id,
        enabled: receptionist.enabled,
        businessName: receptionist.businessName,
        businessEmail: receptionist.businessEmail ?? null,
        assistantName: receptionist.assistantName,
        greeting: receptionist.greeting ?? null,
        knowledge: receptionist.knowledge ?? null,
        faqs: receptionist.faqs ?? null,
        hours: receptionist.hours ?? null,
        serviceArea: receptionist.serviceArea ?? null,
        escalationContact: receptionist.escalationContact ?? null,
        prohibitedActions: receptionist.prohibitedActions ?? null,
        safeAutoReplyCategories: receptionist.safeAutoReplyCategories ?? null,
        retellAgentId: receptionist.retellAgentId ?? null,
        retellPhoneNumber: receptionist.retellPhoneNumber ?? null,
        createdAt: receptionist.createdAt,
        updatedAt: receptionist.updatedAt,
      }),
    );
  },
);

// PATCH /receptionist/:receptionistId/settings
router.patch(
  "/receptionist/:receptionistId/settings",
  async (req, res): Promise<void> => {
    const params = UpdateReceptionistSettingsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const body = UpdateReceptionistSettingsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (
      body.data.retellAgentId !== undefined &&
      body.data.retellAgentId !== PILOT_RETELL_AGENT_ID
    ) {
      res.status(400).json({
        error: "This pilot may only use its dedicated Retell agent.",
      });
      return;
    }

    const now = new Date();
    const [updated] = await db
      .update(receptionistsTable)
      .set({ ...body.data, updatedAt: now })
      .where(eq(receptionistsTable.id, receptionist.id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Receptionist not found." });
      return;
    }

    await db.insert(receptionistAuditEventsTable).values({
      id: newOpaqueId(),
      receptionistId: receptionist.id,
      eventType: "settings_updated",
      metadata: { fields: Object.keys(body.data) },
    });

    res.json(
      UpdateReceptionistSettingsResponse.parse({
        receptionistId: updated.id,
        enabled: updated.enabled,
        businessName: updated.businessName,
        businessEmail: updated.businessEmail ?? null,
        assistantName: updated.assistantName,
        greeting: updated.greeting ?? null,
        knowledge: updated.knowledge ?? null,
        faqs: updated.faqs ?? null,
        hours: updated.hours ?? null,
        serviceArea: updated.serviceArea ?? null,
        escalationContact: updated.escalationContact ?? null,
        prohibitedActions: updated.prohibitedActions ?? null,
        safeAutoReplyCategories: updated.safeAutoReplyCategories ?? null,
        retellAgentId: updated.retellAgentId ?? null,
        retellPhoneNumber: updated.retellPhoneNumber ?? null,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      }),
    );
  },
);

// GET /receptionist/:receptionistId/conversations
router.get(
  "/receptionist/:receptionistId/conversations",
  async (req, res): Promise<void> => {
    const params = ListReceptionistConversationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const conversations = await db
      .select()
      .from(receptionistConversationsTable)
      .where(eq(receptionistConversationsTable.receptionistId, receptionist.id))
      .orderBy(desc(receptionistConversationsTable.updatedAt))
      .limit(50);

    const [totalResult] = await db
      .select({ value: count() })
      .from(receptionistConversationsTable)
      .where(eq(receptionistConversationsTable.receptionistId, receptionist.id));

    // Get message count per conversation
    const convoIds = conversations.map((c) => c.id);
    const msgCounts: Record<string, number> = {};
    if (convoIds.length > 0) {
      // batch count per conversation
      for (const convo of conversations) {
        const [mc] = await db
          .select({ value: count() })
          .from(receptionistMessagesTable)
          .where(
            and(
              eq(receptionistMessagesTable.receptionistId, receptionist.id),
              eq(receptionistMessagesTable.conversationId, convo.id),
            ),
          );
        msgCounts[convo.id] = mc?.value ?? 0;
      }
    }

    res.json(
      ListReceptionistConversationsResponse.parse({
        conversations: conversations.map((c) => ({
          conversationId: c.id,
          receptionistId: c.receptionistId,
          channel: c.channel,
          externalId: c.externalId ?? null,
          subject: c.subject ?? null,
          status: c.status,
          messageCount: msgCounts[c.id] ?? 0,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
        total: totalResult?.value ?? 0,
      }),
    );
  },
);

// GET /receptionist/:receptionistId/conversations/:conversationId
router.get(
  "/receptionist/:receptionistId/conversations/:conversationId",
  async (req, res): Promise<void> => {
    const params = GetConversationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const [conversation] = await db
      .select()
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.id, params.data.conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionist.id),
        ),
      )
      .limit(1);

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const messages = await db
      .select()
      .from(receptionistMessagesTable)
      .where(
        and(
          eq(receptionistMessagesTable.receptionistId, receptionist.id),
          eq(receptionistMessagesTable.conversationId, conversation.id),
        ),
      )
      .orderBy(receptionistMessagesTable.createdAt);

    const auditEvents = await db
      .select()
      .from(receptionistAuditEventsTable)
      .where(
        and(
          eq(receptionistAuditEventsTable.receptionistId, receptionist.id),
          eq(receptionistAuditEventsTable.conversationId, conversation.id),
        ),
      )
      .orderBy(desc(receptionistAuditEventsTable.createdAt))
      .limit(100);

    res.json(
      GetConversationResponse.parse({
        conversationId: conversation.id,
        receptionistId: conversation.receptionistId,
        channel: conversation.channel,
        externalId: conversation.externalId ?? null,
        subject: conversation.subject ?? null,
        status: conversation.status,
        messages: messages.map((m) => ({
          messageId: m.id,
          conversationId: m.conversationId,
          receptionistId: m.receptionistId,
          role: m.role,
          content: m.content,
          approvalState: m.approvalState ?? null,
          externalMessageId: m.externalMessageId ?? null,
          createdAt: m.createdAt,
        })),
        auditEvents: auditEvents.map((event) => ({
          auditEventId: event.id,
          eventType: event.eventType,
          messageId: event.messageId ?? null,
          createdAt: event.createdAt,
        })),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      }),
    );
  },
);

// POST /receptionist/:receptionistId/conversations/:conversationId/reply
router.post(
  "/receptionist/:receptionistId/conversations/:conversationId/reply",
  async (req, res): Promise<void> => {
    const params = OwnerReplyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const body = OwnerReplyBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [conversation] = await db
      .select()
      .from(receptionistConversationsTable)
      .where(
        and(
          eq(receptionistConversationsTable.id, params.data.conversationId),
          eq(receptionistConversationsTable.receptionistId, receptionist.id),
        ),
      )
      .limit(1);

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    const msgId = newOpaqueId();
    const now = new Date();

    await db.insert(receptionistMessagesTable).values({
      id: msgId,
      receptionistId: receptionist.id,
      conversationId: conversation.id,
      role: "owner",
      content: body.data.content,
      approvalState: null,
    });

    await db
      .update(receptionistConversationsTable)
      .set({ updatedAt: now })
      .where(eq(receptionistConversationsTable.id, conversation.id));

    await db.insert(receptionistAuditEventsTable).values({
      id: newOpaqueId(),
      receptionistId: receptionist.id,
      conversationId: conversation.id,
      messageId: msgId,
      eventType: "owner_reply",
    });

    res.status(201).json(
      OwnerReplyResponse.parse({
        messageId: msgId,
        conversationId: conversation.id,
        receptionistId: receptionist.id,
        role: "owner",
        content: body.data.content,
        approvalState: null,
        externalMessageId: null,
        createdAt: now,
      }),
    );
  },
);

// PATCH /receptionist/:receptionistId/conversations/:conversationId/status
router.patch(
  "/receptionist/:receptionistId/conversations/:conversationId/status",
  async (req, res): Promise<void> => {
    const params = UpdateConversationStatusParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const body = UpdateConversationStatusBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const result = await updateConversationStatus({
      receptionistId: receptionist.id,
      conversationId: params.data.conversationId,
      status: body.data.status,
      expectedUpdatedAt: body.data.expectedUpdatedAt,
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }

    if (result.kind === "conflict") {
      res.status(409).json({
        error: "Conversation status changed. Refresh and try again.",
      });
      return;
    }

    res.json(
      UpdateConversationStatusResponse.parse({
        conversationId: result.conversation.id,
        receptionistId: receptionist.id,
        status: result.conversation.status,
        updatedAt: result.conversation.updatedAt,
      }),
    );
  },
);

export default router;
