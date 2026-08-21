/**
 * Provider Registry — provider-neutral typed contracts and default registry.
 *
 * Defines replaceable typed interfaces for every provider capability,
 * maintains honest registry defaults, and exports fail-closed helpers.
 *
 * Rules:
 *  - No network calls anywhere in this module.
 *  - No credentials, tokens, or secrets are stored here.
 *  - Default state is honest about what is actually configured.
 *  - WhatsApp eligibility is fail-closed.
 */

// ─── Capability & Availability unions ─────────────────────────────────────────

export type ProviderCapability =
  | "discovery"
  | "website_analysis"
  | "image"
  | "email"
  | "whatsapp";

export type ProviderAvailability =
  | "not_configured"
  | "available"
  | "disabled"
  | "unavailable"
  | "rate_limited";

// ─── Discovery contract ───────────────────────────────────────────────────────

/** Fields a discovery provider can return facts for. */
export type DiscoveryFactField =
  | "businessName"
  | "category"
  | "address"
  | "city"
  | "region"
  | "postalCode"
  | "phone"
  | "email"
  | "websiteUrl";

/**
 * A single fact from a discovery result.
 * Provenance is always 'provider', with the provider key and a stable
 * provider-specific reference so the fact can be attributed and deduplicated.
 */
export interface DiscoveryFact {
  fieldName: DiscoveryFactField;
  value: string;
  /** Always 'provider' for discovery results. */
  provenance: "provider";
  /** The registry key of the provider that produced this fact. */
  provider: string;
  /** Provider-specific stable reference (e.g. place ID). */
  providerReference: string;
}

/** An image returned by a discovery provider. */
export interface DiscoveryImage {
  url: string;
  sourceUrl?: string | null;
  /** 'approved' images may be used; 'uncertain' images MUST NOT be used. */
  eligibility: "approved" | "uncertain";
  reason?: string | null;
}

/** A single business result from a discovery search. */
export interface DiscoveryResultItem {
  /** Provider-specific stable reference for this business (e.g. place ID). */
  providerReference: string;
  facts: DiscoveryFact[];
  images: DiscoveryImage[];
}

/** Input for a discovery search. */
export interface DiscoverySearchInput {
  category: string;
  location: string;
  maxResults: number;
}

/** Result from a discovery search. */
export interface DiscoverySearchResult {
  provider: string;
  items: DiscoveryResultItem[];
  requestId: string;
  quota?: {
    used: number;
    limit: number;
    remaining: number;
    windowEndsAt: Date;
  } | null;
}

/**
 * Contract for a discovery adapter.
 * A conforming adapter normalizes all facts to provenance='provider' with
 * the provider key and a stable providerReference.
 */
export interface DiscoveryAdapter {
  readonly providerKey: string;
  readonly displayName: string;
  /**
   * Durable owner quota enforced before every provider call. An adapter without
   * a valid quota policy is treated as unavailable rather than called.
   */
  readonly quotaPolicy?: {
    limit: number;
    windowMs: number;
  };
  search(input: DiscoverySearchInput): Promise<DiscoverySearchResult>;
}

// ─── Website Analysis contract ────────────────────────────────────────────────

export interface WebsiteAnalysisInput {
  url: string;
  leadId?: string;
}

export interface WebsiteAnalysisResult {
  provider: string;
  status:
    | "has_website"
    | "no_website"
    | "placeholder"
    | "outdated"
    | "unknown";
  score?: number | null;
  findings?: string[] | null;
  requestId: string;
}

export interface WebsiteAnalysisAdapter {
  readonly providerKey: string;
  readonly displayName: string;
  analyze(input: WebsiteAnalysisInput): Promise<WebsiteAnalysisResult>;
}

// ─── Image contract ───────────────────────────────────────────────────────────

export interface ImageInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface ImageResult {
  provider: string;
  url: string;
  /** 'approved' images may be used on prospect sites; 'uncertain' must not. */
  eligibility: "approved" | "uncertain";
  reason?: string | null;
  requestId: string;
}

export interface ImageAdapter {
  readonly providerKey: string;
  readonly displayName: string;
  generate(input: ImageInput): Promise<ImageResult>;
}

/**
 * Filter a list of images to only those with eligibility='approved'.
 * Uncertain images are NEVER eligible for use on a prospect site.
 */
export function filterProspectSafeImages(
  images: DiscoveryImage[],
): DiscoveryImage[] {
  return images.filter((img) => img.eligibility === "approved");
}

// ─── Email Draft contract ─────────────────────────────────────────────────────

export interface EmailDraftInput {
  to: string;
  subject: string;
  body: string;
  leadId?: string;
  correlationId?: string;
}

export interface EmailDraftResult {
  provider: string;
  externalDraftId?: string | null;
  status: "draft_created" | "queued" | "failed";
  requestId: string;
}

export interface EmailDraftAdapter {
  readonly providerKey: string;
  readonly displayName: string;
  createDraft(input: EmailDraftInput): Promise<EmailDraftResult>;
}

// ─── WhatsApp Business Template Messaging contract ───────────────────────────
//
// Only official Business API templates on approved phone numbers are supported.
// No personal-account WhatsApp. No generic free-form bulk-send interface.

export interface WhatsAppTemplateInput {
  /** E.164 recipient phone number. */
  to: string;
  /** Approved template name registered with the WhatsApp Business Platform. */
  templateName: string;
  /** BCP-47 template language code (e.g. 'en_US'). */
  templateLanguage: string;
  /** Template component parameters. */
  parameters?: Record<string, unknown>;
  leadId?: string;
  correlationId?: string;
}

export interface WhatsAppTemplateResult {
  provider: string;
  externalMessageId?: string | null;
  status: "accepted" | "failed";
  requestId: string;
}

/** Signature verification for inbound WhatsApp webhooks. */
export interface WhatsAppWebhookVerification {
  /** Verify the hub challenge for endpoint registration. */
  verifyChallenge(params: {
    hubMode: string;
    hubChallenge: string;
    hubVerifyToken: string;
  }): string | null;
  /** Verify that a payload was signed by the official WhatsApp provider. */
  verifySignature(payload: Buffer, signature: string): boolean;
}

/**
 * Official WhatsApp Business API adapter.
 * Only approved templates on registered business numbers.
 */
export interface WhatsAppBusinessAdapter {
  readonly providerKey: string;
  readonly displayName: string;
  sendTemplate(input: WhatsAppTemplateInput): Promise<WhatsAppTemplateResult>;
  webhookVerification: WhatsAppWebhookVerification;
}

// ─── Provider Errors ──────────────────────────────────────────────────────────

/**
 * Thrown when a provider capability is unavailable (hard failure or
 * not configured). Maps to HTTP 503.
 */
export class ProviderUnavailableError extends Error {
  readonly availability: ProviderAvailability;

  constructor(
    message: string,
    availability: ProviderAvailability = "unavailable",
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.availability = availability;
  }
}

/**
 * Thrown when a provider returns a rate-limit response. Maps to HTTP 429.
 */
export class ProviderRateLimitError extends Error {
  readonly availability: "rate_limited";
  readonly retryAt?: Date | null;

  constructor(message: string, retryAt?: Date | null) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.availability = "rate_limited";
    this.retryAt = retryAt ?? null;
  }
}

// ─── Registry entry type ──────────────────────────────────────────────────────

export interface ProviderRegistryEntry {
  capability: ProviderCapability;
  providerKey: string | null;
  displayName: string | null;
  availability: ProviderAvailability;
  enabled: boolean;
}

// ─── Registry defaults ────────────────────────────────────────────────────────

/**
 * Static registry defaults.
 *
 * email/gmail: available + enabled by default because the official Gmail
 *   connector is installed and the server uses it in draft-only mode.
 *
 * All other capabilities: not_configured + disabled.
 * Do NOT pretend Google Maps or WhatsApp is configured.
 */
const REGISTRY_DEFAULTS: Record<ProviderCapability, ProviderRegistryEntry> = {
  email: {
    capability: "email",
    providerKey: "gmail",
    displayName: "Gmail",
    availability: "available",
    enabled: true,
  },
  discovery: {
    capability: "discovery",
    providerKey: null,
    displayName: null,
    availability: "not_configured",
    enabled: false,
  },
  website_analysis: {
    capability: "website_analysis",
    providerKey: null,
    displayName: null,
    availability: "not_configured",
    enabled: false,
  },
  image: {
    capability: "image",
    providerKey: null,
    displayName: null,
    availability: "not_configured",
    enabled: false,
  },
  whatsapp: {
    capability: "whatsapp",
    providerKey: null,
    displayName: null,
    availability: "not_configured",
    enabled: false,
  },
};

const providerDisplayNames = new Map<string, string>(
  Object.values(REGISTRY_DEFAULTS)
    .filter(
      (
        entry,
      ): entry is ProviderRegistryEntry & {
        providerKey: string;
        displayName: string;
      } => Boolean(entry.providerKey && entry.displayName),
    )
    .map((entry) => [entry.providerKey, entry.displayName]),
);

export function registerProviderDisplayName(
  providerKey: string,
  displayName: string,
): void {
  const normalizedKey = providerKey.trim();
  const normalizedName = displayName.trim();
  if (!normalizedKey || !normalizedName) {
    throw new TypeError("Provider key and display name must be non-empty.");
  }
  providerDisplayNames.set(normalizedKey, normalizedName);
}

export function getProviderDisplayName(providerKey: string): string {
  return (
    providerDisplayNames.get(providerKey) ??
    providerKey
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

/** Return the registry default for a given capability. */
export function getRegistryDefault(
  capability: ProviderCapability,
): ProviderRegistryEntry {
  return { ...REGISTRY_DEFAULTS[capability] };
}

/** Return all registry defaults. */
export function getAllRegistryDefaults(): ProviderRegistryEntry[] {
  return (Object.keys(REGISTRY_DEFAULTS) as ProviderCapability[]).map(
    (cap) => ({ ...REGISTRY_DEFAULTS[cap] }),
  );
}

// ─── Active adapters (replaceable at runtime by future wiring) ────────────────

/** Registered discovery adapter, if any. */
let _discoveryAdapter: DiscoveryAdapter | null = null;
/** Registered WhatsApp Business adapter, if any. */
let _whatsappAdapter: WhatsAppBusinessAdapter | null = null;

export function setDiscoveryAdapter(adapter: DiscoveryAdapter | null): void {
  _discoveryAdapter = adapter;
  if (adapter) {
    registerProviderDisplayName(adapter.providerKey, adapter.displayName);
  }
}

export function getDiscoveryAdapter(): DiscoveryAdapter | null {
  return _discoveryAdapter;
}

export function setWhatsAppAdapter(
  adapter: WhatsAppBusinessAdapter | null,
): void {
  _whatsappAdapter = adapter;
  if (adapter) {
    registerProviderDisplayName(adapter.providerKey, adapter.displayName);
  }
}

export function getWhatsAppAdapter(): WhatsAppBusinessAdapter | null {
  return _whatsappAdapter;
}

// ─── WhatsApp fail-closed eligibility helper ──────────────────────────────────

export interface WhatsAppEligibilityInput {
  /** Whether the official WhatsApp Business adapter is registered. */
  adapterAvailable: boolean;
  /** Approved template name from provider settings config. */
  templateName: string | null | undefined;
  /** Template language code from provider settings config. */
  templateLanguage: string | null | undefined;
  /** Must be explicitly true in provider settings config. */
  requireExplicitConsent: boolean | undefined;
  /** Lead's WhatsApp consent status. */
  consentStatus: "granted" | "revoked" | "unknown";
}

export interface WhatsAppEligibilityResult {
  eligible: boolean;
  reason: string;
}

/**
 * Fail-closed eligibility check for sending a WhatsApp template message.
 *
 * ALL of the following must be true to return eligible=true:
 *  1. Official adapter is available (registered).
 *  2. templateName is a non-empty string.
 *  3. templateLanguage is a non-empty string.
 *  4. requireExplicitConsent === true (must be explicit).
 *  5. Lead consent status === 'granted'.
 *
 * A revoked or unknown consent blocks WhatsApp permanently/until re-granted.
 * Permanent/general suppression remains enforced by the existing outreach route
 * and is NOT re-checked here (the outreach route is the caller's responsibility).
 */
export function checkWhatsAppEligibility(
  input: WhatsAppEligibilityInput,
): WhatsAppEligibilityResult {
  if (!input.adapterAvailable) {
    return {
      eligible: false,
      reason:
        "No official WhatsApp Business API adapter is configured. Personal-account WhatsApp is not supported.",
    };
  }
  if (!input.templateName || input.templateName.trim() === "") {
    return {
      eligible: false,
      reason:
        "WhatsApp template name is required but not configured. Set an approved template name in provider settings.",
    };
  }
  if (!input.templateLanguage || input.templateLanguage.trim() === "") {
    return {
      eligible: false,
      reason:
        "WhatsApp template language is required but not configured. Set an approved template language in provider settings.",
    };
  }
  if (input.requireExplicitConsent !== true) {
    return {
      eligible: false,
      reason:
        "requireExplicitConsent must be explicitly set to true in provider settings before WhatsApp messaging is allowed.",
    };
  }
  if (input.consentStatus !== "granted") {
    return {
      eligible: false,
      reason:
        input.consentStatus === "revoked"
          ? "Lead has revoked WhatsApp consent. Messaging is permanently blocked until consent is re-granted."
          : "No WhatsApp consent has been recorded for this lead. Explicit consent is required before messaging.",
    };
  }
  return { eligible: true, reason: "All eligibility conditions satisfied." };
}
