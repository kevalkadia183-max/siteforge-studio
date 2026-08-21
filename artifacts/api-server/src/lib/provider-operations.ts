/**
 * Provider Operations — owner-scoped DB helpers for provider capability management.
 *
 * Rules:
 *  - All operations are scoped to an ownerId — cross-owner access is impossible.
 *  - Never accept/store providerKey, status, lastError, quota, credentials, or
 *    tokens from request bodies.
 *  - PATCH may update only: enabled, and the allowlisted config fields.
 *  - Audit events are immutable (append-only). No secrets in detail payloads.
 *  - WhatsApp has additional validation requirements before enablement.
 *  - Status/availability mapping is honest.
 *  - No console.log/console.error — use pino logger.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db,
  providerSettingsTable,
  providerAuditEventsTable,
  providerQuotaWindowsTable,
  type ProviderSettings,
  type ProviderAuditEvent,
  type ProviderQuotaWindow,
} from "@workspace/db";
import {
  type ProviderCapability,
  type ProviderAvailability,
  type ProviderRegistryEntry,
  getRegistryDefault,
  getProviderDisplayName,
  getWhatsAppAdapter,
} from "./provider-registry";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Allowlisted config fields that PATCH may update. */
export interface ProviderConfig {
  whatsappTemplateName?: string | null;
  whatsappTemplateLanguage?: string | null;
  requireExplicitConsent?: boolean;
}

/** A capability's settings merged with registry defaults and active quota. */
export interface CapabilitySettingsMerged {
  capability: ProviderCapability;
  providerKey: string | null;
  displayName: string | null;
  enabled: boolean;
  availability: ProviderAvailability;
  message: string | null;
  rateLimitResetAt: Date | null;
  config: ProviderConfig;
  quota?: {
    used: number;
    limit: number;
    remaining: number;
    windowEndsAt: Date;
  } | null;
}

/** Input for updating capability settings (PATCH body). */
export interface UpdateCapabilityInput {
  enabled?: boolean;
  config?: ProviderConfig;
}

/** A provider audit event row (immutable). */
export interface ProviderAuditEventRecord {
  id: string;
  capability: ProviderCapability;
  providerKey: string;
  eventType: string;
  outcome: "success" | "failure" | "skipped" | "unknown";
  requestId?: string | null;
  externalRef?: string | null;
  detail?: Record<string, unknown> | null;
  occurredAt: Date;
}

/** Input for appending an audit event. */
export interface AppendAuditEventInput {
  ownerId: string;
  capability: ProviderCapability;
  providerKey: string;
  eventType: string;
  outcome: "success" | "failure" | "skipped" | "unknown";
  requestId?: string | null;
  externalRef?: string | null;
  /** No credentials, tokens, or raw response bodies with PII. */
  detail?: Record<string, unknown> | null;
}

/** Result of an atomic quota consumption attempt. */
export interface QuotaConsumeResult {
  consumed: boolean;
  used: number;
  limit: number;
  remaining: number;
  windowEndsAt: Date;
}

// ─── ID generation ────────────────────────────────────────────────────────────

function newId(): string {
  return randomBytes(12).toString("hex");
}

// ─── Availability mapping ─────────────────────────────────────────────────────

/**
 * Map a DB settings row + registry default to an honest ProviderAvailability.
 *
 * Logic:
 *  - If no row exists: not_configured (no provider selected)
 *  - DB status 'disabled' → 'disabled'
 *  - DB status 'unavailable' → 'unavailable'
 *  - DB status 'rate_limited' → 'rate_limited'
 *  - DB status 'configured' → 'available'
 *  - DB status 'not_configured' → 'not_configured'
 *  - Registry default overrides when row providerKey is null (no provider)
 */
function deriveAvailability(
  row: ProviderSettings | null,
  registryDefault: ProviderRegistryEntry,
): ProviderAvailability {
  if (!row) return registryDefault.availability;
  if (!row.providerKey) return "not_configured";
  const s = row.status;
  if (s === "unavailable") return "unavailable";
  if (
    s === "rate_limited" &&
    (row.rateLimitResetAt == null || row.rateLimitResetAt.getTime() > Date.now())
  ) {
    return "rate_limited";
  }
  if (!row.enabled || s === "disabled") return "disabled";
  if (s === "configured") return "available";
  if (s === "rate_limited") return "available";
  return "not_configured";
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

/**
 * Load a single capability's settings merged with registry defaults and the
 * active (non-expired) quota window for this owner.
 */
export async function getCapabilitySettings(
  ownerId: string,
  capability: ProviderCapability,
): Promise<CapabilitySettingsMerged> {
  const registryDefault = getRegistryDefault(capability);

  const [row] = await db
    .select()
    .from(providerSettingsTable)
    .where(
      and(
        eq(providerSettingsTable.ownerId, ownerId),
        eq(providerSettingsTable.capability, capability),
      ),
    )
    .limit(1);

  const dbRow = row ?? null;
  const availability = deriveAvailability(dbRow, registryDefault);
  const providerKey = dbRow?.providerKey ?? registryDefault.providerKey;
  const enabled = dbRow ? dbRow.enabled : registryDefault.enabled;
  const config = (dbRow?.config as ProviderConfig | null) ?? {};
  const rateLimitResetAt = dbRow?.rateLimitResetAt ?? null;
  const displayName = providerKey
    ? getProviderDisplayName(providerKey)
    : registryDefault.displayName;

  // Active quota window (most recent non-expired window for this owner+capability)
  let quota: CapabilitySettingsMerged["quota"] = null;
  if (providerKey) {
    const now = new Date();
    const [qRow] = await db
      .select()
      .from(providerQuotaWindowsTable)
      .where(
        and(
          eq(providerQuotaWindowsTable.ownerId, ownerId),
          eq(providerQuotaWindowsTable.capability, capability),
          eq(providerQuotaWindowsTable.providerKey, providerKey),
          sql`${providerQuotaWindowsTable.windowEndsAt} > ${now}`,
        ),
      )
      .orderBy(desc(providerQuotaWindowsTable.windowStart))
      .limit(1);

    if (qRow) {
      quota = {
        used: qRow.used,
        limit: qRow.limit,
        remaining: Math.max(0, qRow.limit - qRow.used),
        windowEndsAt: qRow.windowEndsAt,
      };
    }
  }

  return {
    capability,
    providerKey: providerKey ?? null,
    displayName,
    enabled,
    availability,
    message: dbRow?.lastError ?? null,
    rateLimitResetAt,
    config: {
      whatsappTemplateName:
        (config as Record<string, unknown>)["whatsappTemplateName"] != null
          ? String((config as Record<string, unknown>)["whatsappTemplateName"])
          : null,
      whatsappTemplateLanguage:
        (config as Record<string, unknown>)["whatsappTemplateLanguage"] != null
          ? String(
              (config as Record<string, unknown>)["whatsappTemplateLanguage"],
            )
          : null,
      requireExplicitConsent:
        typeof (config as Record<string, unknown>)["requireExplicitConsent"] ===
        "boolean"
          ? ((config as Record<string, unknown>)[
              "requireExplicitConsent"
            ] as boolean)
          : undefined,
    },
    quota,
  };
}

/**
 * List all capability settings for an owner, merged with registry defaults.
 */
export async function listAllCapabilitySettings(
  ownerId: string,
): Promise<CapabilitySettingsMerged[]> {
  const capabilities: ProviderCapability[] = [
    "discovery",
    "website_analysis",
    "image",
    "email",
    "whatsapp",
  ];
  const results: CapabilitySettingsMerged[] = [];
  for (const cap of capabilities) {
    results.push(await getCapabilitySettings(ownerId, cap));
  }
  return results;
}

/**
 * Update non-secret capability settings for an owner.
 *
 * Rejected operations:
 *  - requireExplicitConsent=false for WhatsApp
 *  - Enabling WhatsApp without template name+language AND official adapter
 *  - Enabling any capability that is 'not_configured' in the registry
 *    (except email which is pre-configured)
 *
 * Allowed:
 *  - enabled toggle for email (disable/re-enable)
 *  - config field updates for allowlisted fields
 *
 * Persists an audit event for every successful settings change.
 */
export async function updateCapabilitySettings(
  ownerId: string,
  capability: ProviderCapability,
  input: UpdateCapabilityInput,
): Promise<CapabilitySettingsMerged> {
  const registryDefault = getRegistryDefault(capability);
  const current = await getCapabilitySettings(ownerId, capability);

  // ── Validation ─────────────────────────────────────────────────────────────

  if (input.config?.requireExplicitConsent === false && capability === "whatsapp") {
    throw new SettingsValidationError(
      "requireExplicitConsent cannot be set to false for WhatsApp. Explicit consent is always required.",
    );
  }

  if (
    capability !== "whatsapp" &&
    input.config !== undefined &&
    Object.keys(input.config).length > 0
  ) {
    throw new SettingsValidationError(
      `Capability '${capability}' does not accept WhatsApp template settings.`,
    );
  }

  if (input.enabled === true) {
    // Cannot enable a capability that has no configured provider in the registry
    // unless it has a DB row with a configured providerKey.
    if (
      registryDefault.availability === "not_configured" &&
      !current.providerKey
    ) {
      throw new SettingsValidationError(
        `Cannot enable '${capability}': no provider is configured for this capability.`,
        409,
      );
    }

    // WhatsApp: must have template name + language + official adapter
    if (capability === "whatsapp") {
      const templateName =
        input.config?.whatsappTemplateName ?? current.config.whatsappTemplateName;
      const templateLanguage =
        input.config?.whatsappTemplateLanguage ??
        current.config.whatsappTemplateLanguage;
      const adapterAvailable = getWhatsAppAdapter() !== null;

      if (!templateName || templateName.trim() === "") {
        throw new SettingsValidationError(
          "Cannot enable WhatsApp: whatsappTemplateName must be set in config.",
        );
      }
      if (!templateLanguage || templateLanguage.trim() === "") {
        throw new SettingsValidationError(
          "Cannot enable WhatsApp: whatsappTemplateLanguage must be set in config.",
        );
      }
      if (!adapterAvailable) {
        throw new SettingsValidationError(
          "Cannot enable WhatsApp: no official WhatsApp Business API adapter is available.",
          409,
        );
      }
    }
  }

  // ── Build update payload ───────────────────────────────────────────────────

  const existingConfig = current.config as Record<string, unknown>;
  const updatedConfig: Record<string, unknown> = { ...existingConfig };

  if (input.config !== undefined) {
    if ("whatsappTemplateName" in input.config) {
      updatedConfig["whatsappTemplateName"] = input.config.whatsappTemplateName ?? null;
    }
    if ("whatsappTemplateLanguage" in input.config) {
      updatedConfig["whatsappTemplateLanguage"] =
        input.config.whatsappTemplateLanguage ?? null;
    }
    if ("requireExplicitConsent" in input.config) {
      updatedConfig["requireExplicitConsent"] = input.config.requireExplicitConsent;
    }
  }

  const newEnabled = input.enabled !== undefined ? input.enabled : current.enabled;

  // ── Upsert provider_settings row ──────────────────────────────────────────

  const providerKey = current.providerKey ?? registryDefault.providerKey;
  const status =
    input.enabled === true
      ? "configured"
      : input.enabled === false
        ? "disabled"
        : undefined;

  await db.transaction(async (tx) => {
    await tx
      .insert(providerSettingsTable)
      .values({
        ownerId,
        capability,
        providerKey: providerKey ?? null,
        enabled: newEnabled,
        status:
          status ??
          (providerKey && newEnabled
            ? "configured"
            : providerKey
              ? "disabled"
              : "not_configured"),
        config: updatedConfig,
        lastError: null,
        rateLimitResetAt: null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          providerSettingsTable.ownerId,
          providerSettingsTable.capability,
        ],
        set: {
          enabled: newEnabled,
          config: updatedConfig,
          ...(status
            ? { status, lastError: null, rateLimitResetAt: null }
            : {}),
          updatedAt: new Date(),
        },
      });

    const auditDetail: Record<string, unknown> = {
      changedFields: [] as string[],
    };
    if (input.enabled !== undefined) {
      (auditDetail["changedFields"] as string[]).push("enabled");
      auditDetail["enabled"] = input.enabled;
    }
    if (input.config !== undefined) {
      const configFields = Object.keys(input.config).filter(
        (k) => k !== "requireExplicitConsent" || capability === "whatsapp",
      );
      (auditDetail["changedFields"] as string[]).push(
        ...configFields.map((f) => `config.${f}`),
      );
    }

    await appendProviderAuditEvent(
      {
        ownerId,
        capability,
        providerKey: providerKey ?? "none",
        eventType: "settings_updated",
        outcome: "success",
        detail: auditDetail,
      },
      tx,
    );
  });

  return getCapabilitySettings(ownerId, capability);
}

/** Thrown when a settings update violates validation rules. */
export class SettingsValidationError extends Error {
  readonly httpStatus: 400 | 409;

  constructor(message: string, httpStatus: 400 | 409 = 400) {
    super(message);
    this.name = "SettingsValidationError";
    this.httpStatus = httpStatus;
  }
}

// ─── Audit event helpers ──────────────────────────────────────────────────────

/**
 * Append an immutable provider audit event. Never updates existing rows.
 * detail must not contain credentials, tokens, or raw PII-bearing bodies.
 */
export async function appendProviderAuditEvent(
  input: AppendAuditEventInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  txOrDb: any = db,
): Promise<void> {
  assertSafeAuditDetail(input.detail ?? null);
  await txOrDb.insert(providerAuditEventsTable).values({
    id: newId(),
    ownerId: input.ownerId,
    capability: input.capability,
    providerKey: input.providerKey,
    eventType: input.eventType,
    outcome: input.outcome,
    requestId: input.requestId ?? null,
    externalRef: input.externalRef ?? null,
    detail: input.detail ?? null,
  });
}

const FORBIDDEN_AUDIT_KEY =
  /(authorization|cookie|credential|password|secret|token|signature|raw[_-]?(body|payload|request|response)?|request[_-]?body|response[_-]?body)/i;

function assertSafeAuditDetail(
  detail: Record<string, unknown> | null,
): void {
  if (detail == null) return;

  const serialized = JSON.stringify(detail);
  if (serialized.length > 4_096) {
    throw new TypeError("Provider audit detail exceeds the 4096-byte limit.");
  }

  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) {
      throw new TypeError("Provider audit detail exceeds the nesting limit.");
    }
    if (typeof value === "string" && value.length > 1_000) {
      throw new TypeError("Provider audit detail contains an oversized string.");
    }
    if (Array.isArray(value)) {
      if (value.length > 50) {
        throw new TypeError("Provider audit detail contains an oversized array.");
      }
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (FORBIDDEN_AUDIT_KEY.test(key)) {
          throw new TypeError(
            `Provider audit detail contains forbidden key '${key}'.`,
          );
        }
        visit(child, depth + 1);
      }
    }
  };

  visit(detail, 0);
}

/**
 * List immutable provider audit events for an owner, most recent first.
 * Optionally filtered by capability.
 */
export async function listProviderAuditEvents(
  ownerId: string,
  opts: { capability?: ProviderCapability; limit?: number },
): Promise<ProviderAuditEventRecord[]> {
  const limit = Math.min(opts.limit ?? 25, 100);

  const conditions = [eq(providerAuditEventsTable.ownerId, ownerId)];
  if (opts.capability) {
    conditions.push(eq(providerAuditEventsTable.capability, opts.capability));
  }

  const rows = await db
    .select()
    .from(providerAuditEventsTable)
    .where(and(...conditions))
    .orderBy(desc(providerAuditEventsTable.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    capability: r.capability as ProviderCapability,
    providerKey: r.providerKey,
    eventType: r.eventType,
    outcome: r.outcome as ProviderAuditEventRecord["outcome"],
    requestId: r.requestId ?? null,
    externalRef: r.externalRef ?? null,
    detail: r.detail as Record<string, unknown> | null,
    occurredAt: r.occurredAt,
  }));
}

// ─── Quota helpers ────────────────────────────────────────────────────────────

/**
 * Atomically consume one unit of quota for the given owner+capability+provider
 * within the current window.
 *
 * Uses INSERT...ON CONFLICT...DO UPDATE...WHERE used < limit RETURNING.
 * Returns consumed=false when the quota is exhausted.
 *
 * windowStart and windowEndsAt define the rolling window (caller supplies).
 * limit is the maximum usage for this window.
 */
export async function consumeQuotaAtomic(opts: {
  ownerId: string;
  capability: ProviderCapability;
  providerKey: string;
  windowStart: Date;
  windowEndsAt: Date;
  limit: number;
}): Promise<QuotaConsumeResult> {
  const { ownerId, capability, providerKey, windowStart, windowEndsAt, limit } =
    opts;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Provider quota limit must be a positive integer.");
  }
  if (windowEndsAt.getTime() <= windowStart.getTime()) {
    throw new RangeError("Provider quota window end must be after its start.");
  }

  const windowId = newId();

  // A conflict update only runs while capacity remains. PostgreSQL returns no
  // row when the WHERE guard rejects the update, which is the exhausted signal.
  const inserted = await db
    .insert(providerQuotaWindowsTable)
    .values({
      id: windowId,
      ownerId,
      capability,
      providerKey,
      windowStart,
      windowEndsAt,
      used: 1,
      limit,
    })
    .onConflictDoUpdate({
      target: [
        providerQuotaWindowsTable.ownerId,
        providerQuotaWindowsTable.capability,
        providerQuotaWindowsTable.providerKey,
        providerQuotaWindowsTable.windowStart,
      ],
      set: {
        used: sql`${providerQuotaWindowsTable.used} + 1`,
      },
      setWhere: sql`${providerQuotaWindowsTable.used} < ${providerQuotaWindowsTable.limit}`,
    })
    .returning();

  if (!inserted[0]) {
    const [exhausted] = await db
      .select()
      .from(providerQuotaWindowsTable)
      .where(
        and(
          eq(providerQuotaWindowsTable.ownerId, ownerId),
          eq(providerQuotaWindowsTable.capability, capability),
          eq(providerQuotaWindowsTable.providerKey, providerKey),
          eq(providerQuotaWindowsTable.windowStart, windowStart),
        ),
      )
      .limit(1);

    return {
      consumed: false,
      used: exhausted?.used ?? limit,
      limit: exhausted?.limit ?? limit,
      remaining: 0,
      windowEndsAt: exhausted?.windowEndsAt ?? windowEndsAt,
    };
  }

  const row = inserted[0] as ProviderQuotaWindow;

  return {
    consumed: true,
    used: row.used,
    limit: row.limit,
    remaining: Math.max(0, row.limit - row.used),
    windowEndsAt: row.windowEndsAt,
  };
}

/**
 * Persist a rate-limited status to the provider_settings row for an owner+capability.
 */
export async function persistRateLimitedStatus(
  ownerId: string,
  capability: ProviderCapability,
  providerKey: string,
  retryAt: Date | null,
): Promise<void> {
  await db
    .insert(providerSettingsTable)
    .values({
      ownerId,
      capability,
      providerKey,
      enabled: true,
      status: "rate_limited",
      rateLimitResetAt: retryAt ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [providerSettingsTable.ownerId, providerSettingsTable.capability],
      set: {
        status: "rate_limited",
        rateLimitResetAt: retryAt ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Persist an unavailable status to the provider_settings row.
 */
export async function persistUnavailableStatus(
  ownerId: string,
  capability: ProviderCapability,
  providerKey: string,
  errorMessage: string | null,
): Promise<void> {
  await db
    .insert(providerSettingsTable)
    .values({
      ownerId,
      capability,
      providerKey,
      enabled: true,
      status: "unavailable",
      lastError: errorMessage ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [providerSettingsTable.ownerId, providerSettingsTable.capability],
      set: {
        status: "unavailable",
        lastError: errorMessage ?? null,
        updatedAt: new Date(),
      },
    });
}

/** Clear a transient provider error after a successful operation. */
export async function persistAvailableStatus(
  ownerId: string,
  capability: ProviderCapability,
  providerKey: string,
): Promise<void> {
  await db
    .insert(providerSettingsTable)
    .values({
      ownerId,
      capability,
      providerKey,
      enabled: true,
      status: "configured",
      lastError: null,
      rateLimitResetAt: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [providerSettingsTable.ownerId, providerSettingsTable.capability],
      set: {
        status: "configured",
        lastError: null,
        rateLimitResetAt: null,
        updatedAt: new Date(),
      },
    });
}
