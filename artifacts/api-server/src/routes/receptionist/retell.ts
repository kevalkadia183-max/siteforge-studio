import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  db,
  receptionistsTable,
  receptionistConversationsTable,
} from "@workspace/db";
import {
  SyncRetellCallsParams,
  SyncRetellCallsResponse,
} from "@workspace/api-zod";
import { verifyReceptionistOwner } from "../../lib/receptionist-owner-auth";
import { PILOT_RETELL_AGENT_ID } from "../../lib/receptionist-retell";
import { importEndedRetellCall } from "../../lib/retell-call-store";
import { recordRejectedRetellWebhook } from "../../lib/retell-webhook-audit";
import {
  hashRetellWebhookPayload,
  parseRetellWebhookPayload,
  verifyRetellWebhookSignature,
  type RetellCall,
} from "../../lib/retell-webhook";

const router: IRouter = Router();

async function auditRejectedWebhook(
  req: import("express").Request,
  metadata: Record<string, unknown>,
) {
  try {
    await recordRejectedRetellWebhook(metadata);
  } catch (error) {
    req.log.error(
      { error, reason: metadata.reason, payloadHash: metadata.payloadHash },
      "Failed to persist rejected Retell webhook audit",
    );
  }
}

// Owner auth is now handled by the shared verifyReceptionistOwner helper.

// POST /receptionist/retell/webhook
router.post(
  "/receptionist/retell/webhook",
  async (req, res): Promise<void> => {
    const apiKey = process.env.RETELL_WEBHOOK_API_KEY?.trim();
    if (!apiKey) {
      req.log.error("RETELL_WEBHOOK_API_KEY is not configured");
      res.status(503).json({ error: "Retell webhook is not configured." });
      return;
    }

    if (!Buffer.isBuffer(req.body)) {
      await auditRejectedWebhook(req, {
        reason: "invalid_content_type",
        payloadHash: null,
      });
      res.status(400).json({ error: "Expected an application/json payload." });
      return;
    }

    const rawBody = req.body.toString("utf8");
    const payloadHash = hashRetellWebhookPayload(rawBody);
    const signature = req.get("X-Retell-Signature") ?? undefined;
    const verification = verifyRetellWebhookSignature(
      rawBody,
      apiKey,
      signature,
    );
    if (!verification.valid) {
      await auditRejectedWebhook(req, {
        reason: verification.reason,
        payloadHash,
        signatureTimestamp: verification.timestamp,
      });
      res.status(401).json({ error: "Invalid Retell webhook signature." });
      return;
    }

    const payload = parseRetellWebhookPayload(rawBody);
    if (payload.kind === "invalid") {
      await auditRejectedWebhook(req, {
        reason: payload.reason,
        payloadHash,
        signatureTimestamp: verification.timestamp,
      });
      res.status(400).json({ error: "Invalid Retell webhook payload." });
      return;
    }
    if (payload.kind === "ignored") {
      res.status(204).end();
      return;
    }

    const agentId = payload.call.agent_id;
    if (agentId !== PILOT_RETELL_AGENT_ID) {
      await auditRejectedWebhook(req, {
        reason: "unconfigured_agent",
        payloadHash,
        signatureTimestamp: verification.timestamp,
        eventType: "call_ended",
        callId: payload.call.call_id,
        agentId,
      });
      res.status(204).end();
      return;
    }

    const [receptionist] = await db
      .select()
      .from(receptionistsTable)
      .where(
        and(
          eq(receptionistsTable.retellAgentId, agentId),
          eq(receptionistsTable.enabled, true),
        ),
      )
      .limit(1);
    if (!receptionist) {
      await auditRejectedWebhook(req, {
        reason: "unconfigured_agent",
        payloadHash,
        signatureTimestamp: verification.timestamp,
        eventType: "call_ended",
        callId: payload.call.call_id,
        agentId,
      });
      res.status(204).end();
      return;
    }

    try {
      const deliveryKey = `call_ended:${payload.call.call_id}`;
      const outcome = await importEndedRetellCall({
        receptionistId: receptionist.id,
        call: payload.call,
        source: "webhook",
        webhook: {
          deliveryKey,
          payloadHash,
          signatureTimestamp: verification.timestamp,
        },
      });
      req.log.info(
        {
          receptionistId: receptionist.id,
          callId: payload.call.call_id,
          outcome: outcome.kind,
        },
        "Processed Retell call-ended webhook",
      );
      res.status(204).end();
    } catch (error) {
      req.log.error({ error }, "Retell webhook ingestion failed");
      res.status(503).json({ error: "Retell webhook could not be processed." });
    }
  },
);

// POST /receptionist/:receptionistId/retell/sync
router.post(
  "/receptionist/:receptionistId/retell/sync",
  async (req, res): Promise<void> => {
    const params = SyncRetellCallsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const receptionist = await verifyReceptionistOwner(req, res, params.data.receptionistId);
    if (!receptionist) return;

    const agentId = receptionist.retellAgentId;
    if (agentId !== PILOT_RETELL_AGENT_ID) {
      res.status(400).json({
        error: "This pilot may only sync its dedicated Retell agent.",
      });
      return;
    }

    let callsChecked = 0;
    let newConversations = 0;
    let newMessages = 0;

    const connectors = new ReplitConnectors();

    try {
      // List calls for configured agent (POST v3/list-calls)
      const listResp = await connectors.proxy("retell-ai", "/v3/list-calls", {
        method: "POST",
        body: {
          filter_criteria: { agent: [{ agent_id: agentId }] },
          limit: 20,
          sort_order: "descending",
        },
        headers: { "Content-Type": "application/json" },
      });

      if (!listResp.ok) {
        req.log.warn({ status: listResp.status }, "Retell list-calls failed");
        res.status(502).json({ error: "Retell connector returned an error." });
        return;
      }

      const listData = (await listResp.json()) as {
        items?: Array<Partial<RetellCall>>;
      };

      const calls = listData.items ?? [];
      callsChecked = calls.length;

      // Collect existing external IDs
      const existingConvos = await db
        .select({ externalId: receptionistConversationsTable.externalId })
        .from(receptionistConversationsTable)
        .where(
          and(
            eq(receptionistConversationsTable.receptionistId, receptionist.id),
            eq(receptionistConversationsTable.channel, "call"),
          ),
        );
      const knownCallIds = new Set(
        existingConvos.map((c) => c.externalId).filter(Boolean),
      );

      for (const call of calls) {
        const callId = call.call_id;
        if (
          !callId ||
          knownCallIds.has(callId) ||
          call.call_status !== "ended"
        ) {
          continue;
        }

        const imported = await importEndedRetellCall({
          receptionistId: receptionist.id,
          call: call as RetellCall,
          source: "manual_sync",
        });
        if (!imported.conversationCreated) {
          knownCallIds.add(callId);
          continue;
        }
        newConversations++;
        newMessages += imported.messagesCreated;
        knownCallIds.add(callId);
      }
    } catch (err) {
      req.log.error({ error: err }, "Retell sync error");
      res.status(502).json({ error: "Failed to sync Retell calls." });
      return;
    }

    res.json(
      SyncRetellCallsResponse.parse({ callsChecked, newConversations, newMessages }),
    );
  },
);

export default router;
