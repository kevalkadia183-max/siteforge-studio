/**
 * Lead acquisition: provider settings, discovery, and consent routes.
 *
 * GET    /provider-settings
 * PATCH  /provider-settings/:capability
 * GET    /provider-audit
 * POST   /lead-acquisition/discovery/search
 * GET    /leads/:leadId/consents/whatsapp
 * PUT    /leads/:leadId/consents/whatsapp
 *
 * Security invariants:
 *  - All routes require authentication (requireAuth).
 *  - ownerId always comes from req.sfUserId — never from request bodies.
 *  - Owner IDs, secrets, raw webhook bodies, and credentials are never exposed.
 *  - Discovery is limited to maxResults ≤ 20.
 *  - WhatsApp consent PUT runs inside withLeadMutationLock.
 */

import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import {
  db,
  leadsTable,
  leadChannelConsentsTable,
  leadActivitiesTable,
  providerAuditEventsTable,
} from "@workspace/db";
import {
  GetProviderSettingsResponse,
  UpdateProviderSettingParams,
  UpdateProviderSettingBody,
  UpdateProviderSettingResponse,
  ListProviderAuditEventsQueryParams,
  ListProviderAuditEventsResponse,
  SearchBusinessesBody,
  SearchBusinessesResponse,
  GetLeadWhatsAppConsentParams,
  GetLeadWhatsAppConsentResponse,
  UpdateLeadWhatsAppConsentParams,
  UpdateLeadWhatsAppConsentBody,
  UpdateLeadWhatsAppConsentResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import {
  getDiscoveryAdapter,
  ProviderUnavailableError,
  ProviderRateLimitError,
  type ProviderCapability,
} from "../../lib/provider-registry";
import {
  listAllCapabilitySettings,
  updateCapabilitySettings,
  listProviderAuditEvents,
  appendProviderAuditEvent,
  SettingsValidationError,
  persistRateLimitedStatus,
  persistUnavailableStatus,
  persistAvailableStatus,
  getCapabilitySettings,
  consumeQuotaAtomic,
} from "../../lib/provider-operations";
import { withLeadMutationLock } from "../../lib/lead-mutation-lock";
import { newId } from "./helpers";

export const providersRouter: IRouter = Router();

// ─── GET /provider-settings ───────────────────────────────────────────────────

providersRouter.get(
  "/provider-settings",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const capabilities = await listAllCapabilitySettings(ownerId);

    res.json(
      GetProviderSettingsResponse.parse({
        capabilities: capabilities.map((c) => ({
          capability: c.capability,
          providerKey: c.providerKey ?? null,
          displayName: c.displayName ?? null,
          enabled: c.enabled,
          availability: c.availability,
          message: c.message ?? null,
          rateLimitResetAt: c.rateLimitResetAt ?? null,
          config: {
            whatsappTemplateName: c.config.whatsappTemplateName ?? null,
            whatsappTemplateLanguage: c.config.whatsappTemplateLanguage ?? null,
            requireExplicitConsent: c.config.requireExplicitConsent,
          },
          quota: c.quota ?? null,
        })),
        updatedAt: new Date(),
      }),
    );
  },
);

// ─── PATCH /provider-settings/:capability ────────────────────────────────────

providersRouter.patch(
  "/provider-settings/:capability",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = UpdateProviderSettingParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const body = UpdateProviderSettingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    if (body.data.enabled === undefined && body.data.config === undefined) {
      res.status(400).json({
        error: "At least one of enabled or config must be provided.",
      });
      return;
    }

    const capability = params.data.capability;

    try {
      const updated = await updateCapabilitySettings(ownerId, capability, {
        enabled: body.data.enabled,
        config: body.data.config
          ? {
              whatsappTemplateName:
                body.data.config.whatsappTemplateName ?? undefined,
              whatsappTemplateLanguage:
                body.data.config.whatsappTemplateLanguage ?? undefined,
              requireExplicitConsent:
                body.data.config.requireExplicitConsent ?? undefined,
            }
          : undefined,
      });

      res.json(
        UpdateProviderSettingResponse.parse({
          capability: updated.capability,
          providerKey: updated.providerKey ?? null,
          displayName: updated.displayName ?? null,
          enabled: updated.enabled,
          availability: updated.availability,
          message: updated.message ?? null,
          rateLimitResetAt: updated.rateLimitResetAt ?? null,
          config: {
            whatsappTemplateName: updated.config.whatsappTemplateName ?? null,
            whatsappTemplateLanguage:
              updated.config.whatsappTemplateLanguage ?? null,
            requireExplicitConsent: updated.config.requireExplicitConsent,
          },
          quota: updated.quota ?? null,
        }),
      );
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        res.status(err.httpStatus).json({ error: err.message });
        return;
      }
      throw err;
    }
  },
);

// ─── GET /provider-audit ──────────────────────────────────────────────────────

providersRouter.get(
  "/provider-audit",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const query = ListProviderAuditEventsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const events = await listProviderAuditEvents(ownerId, {
      capability: query.data.capability as ProviderCapability | undefined,
      limit: query.data.limit,
    });

    res.json(
      ListProviderAuditEventsResponse.parse({
        items: events.map((e) => ({
          id: e.id,
          capability: e.capability,
          providerKey: e.providerKey,
          eventType: e.eventType,
          outcome: e.outcome,
          requestId: e.requestId ?? null,
          externalRef: e.externalRef ?? null,
          detail: e.detail ? JSON.stringify(e.detail) : null,
          occurredAt: e.occurredAt,
        })),
      }),
    );
  },
);

// ─── POST /lead-acquisition/discovery/search ──────────────────────────────────

providersRouter.post(
  "/lead-acquisition/discovery/search",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const body = SearchBusinessesBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    // maxResults must be a true integer (Number.isInteger), even though OpenAPI
    // uses number for generator compatibility.
    if (!Number.isInteger(body.data.maxResults)) {
      res.status(400).json({ error: "maxResults must be an integer." });
      return;
    }

    // Enforce max 20 to prevent bulk discovery
    const maxResults = Math.min(body.data.maxResults, 20);

    const adapter = getDiscoveryAdapter();

    if (!adapter) {
      // No approved discovery adapter — return 503 and append audit event
      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: "none",
        eventType: "search_attempted",
        outcome: "skipped",
        detail: {
          reason: "no_adapter_configured",
          category: body.data.category,
          location: body.data.location,
        },
      });

      res.status(503).json({
        error: "provider_unavailable",
        message: "Discovery provider not configured.",
        availability: "not_configured",
      });
      return;
    }

    const settings = await getCapabilitySettings(ownerId, "discovery");
    if (
      !settings.enabled ||
      settings.availability !== "available" ||
      settings.providerKey !== adapter.providerKey
    ) {
      const isRateLimited = settings.availability === "rate_limited";
      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: settings.providerKey ?? adapter.providerKey,
        eventType: "search_attempted",
        outcome: "skipped",
        detail: {
          reason:
            settings.providerKey !== adapter.providerKey
              ? "configured_provider_mismatch"
              : `provider_${settings.availability}`,
        },
      });

      if (isRateLimited) {
        res.status(429).json({
          error: "rate_limited",
          message: settings.message ?? "Discovery quota is temporarily exhausted.",
          retryAt: settings.rateLimitResetAt?.toISOString() ?? null,
        });
        return;
      }

      res.status(503).json({
        error: "provider_unavailable",
        message:
          settings.message ??
          (settings.availability === "disabled"
            ? "Discovery provider is disabled."
            : "Discovery provider is not available for this workspace."),
        availability:
          settings.providerKey !== adapter.providerKey
            ? "unavailable"
            : settings.availability,
      });
      return;
    }

    const requestId = randomBytes(12).toString("hex");
    const quotaPolicy = adapter.quotaPolicy;
    if (
      !quotaPolicy ||
      !Number.isInteger(quotaPolicy.limit) ||
      quotaPolicy.limit < 1 ||
      quotaPolicy.limit > 1_000_000 ||
      !Number.isInteger(quotaPolicy.windowMs) ||
      quotaPolicy.windowMs < 1_000 ||
      quotaPolicy.windowMs > 31 * 24 * 60 * 60 * 1_000
    ) {
      const message =
        "Discovery provider quota policy is not configured correctly.";
      await persistUnavailableStatus(
        ownerId,
        "discovery",
        adapter.providerKey,
        message,
      );
      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: adapter.providerKey,
        eventType: "provider_error",
        outcome: "failure",
        requestId,
        detail: { reason: "invalid_quota_policy" },
      });
      res.status(503).json({
        error: "provider_unavailable",
        message,
        availability: "unavailable",
      });
      return;
    }

    const now = Date.now();
    const windowStartMs =
      Math.floor(now / quotaPolicy.windowMs) * quotaPolicy.windowMs;
    const quota = await consumeQuotaAtomic({
      ownerId,
      capability: "discovery",
      providerKey: adapter.providerKey,
      windowStart: new Date(windowStartMs),
      windowEndsAt: new Date(windowStartMs + quotaPolicy.windowMs),
      limit: quotaPolicy.limit,
    });

    if (!quota.consumed) {
      await persistRateLimitedStatus(
        ownerId,
        "discovery",
        adapter.providerKey,
        quota.windowEndsAt,
      );
      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: adapter.providerKey,
        eventType: "rate_limited",
        outcome: "skipped",
        requestId,
        detail: {
          reason: "quota_exhausted",
          retryAt: quota.windowEndsAt.toISOString(),
        },
      });
      res.status(429).json({
        error: "rate_limited",
        message: "Discovery quota is exhausted for the current window.",
        retryAt: quota.windowEndsAt.toISOString(),
      });
      return;
    }

    try {
      const result = await adapter.search({
        category: body.data.category,
        location: body.data.location,
        maxResults,
      });

      await persistAvailableStatus(
        ownerId,
        "discovery",
        adapter.providerKey,
      );
      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: adapter.providerKey,
        eventType: "search_completed",
        outcome: "success",
        requestId,
        detail: {
          category: body.data.category,
          location: body.data.location,
          maxResults,
          itemCount: result.items.length,
        },
      });

      res.json(
        SearchBusinessesResponse.parse({
          provider: adapter.providerKey,
          items: result.items.map((item) => ({
            providerReference: item.providerReference,
            facts: item.facts.map((f) => ({
              fieldName: f.fieldName,
              value: f.value,
              provenance: "provider" as const,
              provider: adapter.providerKey,
              providerReference:
                f.providerReference ?? item.providerReference,
            })),
            images: item.images.map((img) => ({
              url: img.url,
              sourceUrl: img.sourceUrl ?? null,
              eligibility: img.eligibility,
              reason: img.reason ?? null,
            })),
          })),
          requestId: result.requestId,
          quota,
        }),
      );
    } catch (err) {
      if (err instanceof ProviderRateLimitError) {
        const retryAt = err.retryAt;

        // Persist rate_limited status
        await persistRateLimitedStatus(
          ownerId,
          "discovery",
          adapter.providerKey,
          retryAt ?? null,
        );

        await appendProviderAuditEvent({
          ownerId,
          capability: "discovery",
          providerKey: adapter.providerKey,
          eventType: "rate_limited",
          outcome: "failure",
          requestId,
          detail: {
            retryAt: retryAt?.toISOString() ?? null,
            message: err.message,
          },
        });

        res.status(429).json({
          error: "rate_limited",
          message: err.message,
          retryAt: retryAt?.toISOString() ?? null,
        });
        return;
      }

      if (err instanceof ProviderUnavailableError) {
        await persistUnavailableStatus(
          ownerId,
          "discovery",
          adapter.providerKey,
          err.message,
        );

        await appendProviderAuditEvent({
          ownerId,
          capability: "discovery",
          providerKey: adapter.providerKey,
          eventType: "provider_error",
          outcome: "failure",
          requestId,
          detail: { message: err.message, availability: err.availability },
        });

        res.status(503).json({
          error: "provider_unavailable",
          message: err.message,
          availability: err.availability,
        });
        return;
      }

      // Hard provider failure — persist and return 503
      await persistUnavailableStatus(
        ownerId,
        "discovery",
        adapter.providerKey,
        err instanceof Error ? err.message : "Unknown provider error",
      );

      await appendProviderAuditEvent({
        ownerId,
        capability: "discovery",
        providerKey: adapter.providerKey,
        eventType: "provider_error",
        outcome: "failure",
        requestId,
        detail: {
          message:
            err instanceof Error ? err.message : "Unknown provider error",
        },
      });

      res.status(503).json({
        error: "provider_unavailable",
        message: "Discovery provider encountered an error.",
        availability: "unavailable",
      });
    }
  },
);

// ─── GET /leads/:leadId/consents/whatsapp ─────────────────────────────────────

providersRouter.get(
  "/leads/:leadId/consents/whatsapp",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = GetLeadWhatsAppConsentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    // Verify owner+lead exists
    const [lead] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
      .limit(1);

    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    // Look up consent row
    const [consentRow] = await db
      .select()
      .from(leadChannelConsentsTable)
      .where(
        and(
          eq(leadChannelConsentsTable.ownerId, ownerId),
          eq(leadChannelConsentsTable.leadId, leadId),
          eq(leadChannelConsentsTable.channel, "whatsapp"),
        ),
      )
      .limit(1);

    if (!consentRow) {
      // Absent row → synthetic unknown consent with source='not_recorded'
      const now = new Date();
      res.json(
        GetLeadWhatsAppConsentResponse.parse({
          leadId,
          channel: "whatsapp",
          status: "unknown",
          source: "not_recorded",
          evidenceRef: null,
          capturedAt: now,
          updatedAt: now,
        }),
      );
      return;
    }

    res.json(
      GetLeadWhatsAppConsentResponse.parse({
        leadId,
        channel: "whatsapp",
        status: consentRow.status,
        source: consentRow.source,
        evidenceRef: consentRow.evidenceRef ?? null,
        capturedAt: consentRow.capturedAt,
        updatedAt: consentRow.updatedAt,
      }),
    );
  },
);

// ─── PUT /leads/:leadId/consents/whatsapp ─────────────────────────────────────

providersRouter.put(
  "/leads/:leadId/consents/whatsapp",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = UpdateLeadWhatsAppConsentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = UpdateLeadWhatsAppConsentBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    // Require non-empty evidenceRef when granting
    if (
      body.data.status === "granted" &&
      (!body.data.evidenceRef || body.data.evidenceRef.trim() === "")
    ) {
      res.status(400).json({
        error:
          "evidenceRef is required and must be non-empty when granting consent.",
      });
      return;
    }

    // Check lead exists before acquiring lock (avoids holding lock for non-existent leads)
    const [leadCheck] = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
      .limit(1);

    if (!leadCheck) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    let consentRecord: {
      leadId: string;
      channel: "whatsapp";
      status: "granted" | "revoked" | "unknown";
      source: string;
      evidenceRef: string | null;
      capturedAt: Date;
      updatedAt: Date;
    } | null = null;

    let leadNotFound = false;

    await withLeadMutationLock(ownerId, leadId, async (lockedDb) => {
      await lockedDb.transaction(async (tx) => {
        // Re-check owner+lead inside transaction under lock
        const [lead] = await tx
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
          .limit(1);

        if (!lead) {
          leadNotFound = true;
          return;
        }

        const now = new Date();

        // Upsert consent row
        const [upserted] = await tx
          .insert(leadChannelConsentsTable)
          .values({
            id: newId(),
            ownerId,
            leadId,
            channel: "whatsapp",
            status: body.data.status,
            source: body.data.source,
            evidenceRef: body.data.evidenceRef ?? null,
            capturedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              leadChannelConsentsTable.ownerId,
              leadChannelConsentsTable.leadId,
              leadChannelConsentsTable.channel,
            ],
            set: {
              status: body.data.status,
              source: body.data.source,
              evidenceRef: body.data.evidenceRef ?? null,
              updatedAt: now,
            },
          })
          .returning();

        // Append lead activity
        await tx.insert(leadActivitiesTable).values({
          id: newId(),
          leadId,
          ownerId,
          activityType: `whatsapp_consent_${body.data.status}`,
          note: `WhatsApp consent ${body.data.status} via ${body.data.source}`,
          performedBy: ownerId,
        });

        // Append provider audit event
        await tx.insert(providerAuditEventsTable).values({
          id: newId(),
          ownerId,
          capability: "whatsapp",
          providerKey: "whatsapp_consent",
          eventType: "consent_updated",
          outcome: "success",
          detail: {
            leadId,
            status: body.data.status,
            source: body.data.source,
          },
        });

        consentRecord = {
          leadId,
          channel: "whatsapp",
          status: upserted.status as "granted" | "revoked" | "unknown",
          source: upserted.source,
          evidenceRef: upserted.evidenceRef ?? null,
          capturedAt: upserted.capturedAt,
          updatedAt: upserted.updatedAt,
        };
      });
    });

    if (leadNotFound) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    if (!consentRecord) {
      res.status(500).json({ error: "Consent record was not created." });
      return;
    }

    res.json(UpdateLeadWhatsAppConsentResponse.parse(consentRecord));
  },
);
