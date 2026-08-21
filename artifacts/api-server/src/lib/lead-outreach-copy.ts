/**
 * Lead outreach copy — pure, deterministic, testable helpers.
 *
 * NO LLM. NO network. NO randomness. Given a set of allowlisted, stored,
 * provenance-approved lead facts, this module deterministically renders a
 * first-contact outreach draft (subject + body) and a fact snapshot.
 *
 * Hard safety rules enforced here:
 *   - Only allowlisted fact fields are ever considered.
 *   - Only facts with provenance in APPROVED_PROVENANCE are usable.
 *     ("user_provided" or "verified"; imported/inferred/ai_generated/provider
 *     are NOT usable unless the owner explicitly confirmed them — see routes).
 *   - businessName is required; without it, rendering fails.
 *   - The copy NEVER fabricates claims/ratings/guarantees/credentials/
 *     availability/discounts/testimonials/delivery claims. It only restates
 *     the exact facts that were provided.
 *
 * All exports are pure so they can be unit-tested without a DB or network.
 */

/** Fields an outreach draft may reference. Nothing outside this list is used. */
export const OUTREACH_ALLOWED_FIELDS = [
  "businessName",
  "category",
  "city",
  "region",
  "websiteUrl",
  "services",
  "description",
] as const;

export type OutreachField = (typeof OUTREACH_ALLOWED_FIELDS)[number];

/** Provenance values that make a stored fact usable without owner confirmation. */
export const APPROVED_PROVENANCE = ["user_provided", "verified"] as const;

export type Provenance =
  | "user_provided"
  | "imported"
  | "verified"
  | "inferred"
  | "ai_generated"
  | "provider";

/** A single fact reference used to render copy (audit-grade snapshot entry). */
export type FactReference = {
  fieldName: OutreachField;
  value: string;
  provenance: Provenance;
  /** Optional id of the lead_acquisition_sources row this came from. */
  sourceId?: string | null;
};

export type OutreachRenderInput = {
  /** The selected fields the caller asked to include (allowlist subset). */
  selectedFields: OutreachField[];
  /**
   * Provenance-approved facts keyed by field name. Values come from the stored
   * lead row / verified source rows only — never from client-supplied values.
   */
  facts: Partial<Record<OutreachField, FactReference>>;
  /** Optional friendly display name for the sender's own business (owner). */
  senderName?: string | null;
};

export type OutreachRenderResult =
  | {
      ok: true;
      subject: string;
      body: string;
      /** Exact facts used, in rendering order — snapshot + references. */
      factSnapshot: FactReference[];
    }
  | {
      ok: false;
      /** Machine-readable reason for the failure. */
      reason: "missing_business_name" | "no_usable_facts";
      /** Field names that were requested but had unapproved/absent provenance. */
      unavailableFields: OutreachField[];
    };

/** Is this field one we are allowed to reference at all? */
export function isAllowedOutreachField(field: string): field is OutreachField {
  return (OUTREACH_ALLOWED_FIELDS as readonly string[]).includes(field);
}

/** Does this provenance make a fact usable without explicit owner confirmation? */
export function isApprovedProvenance(p: string): boolean {
  return (APPROVED_PROVENANCE as readonly string[]).includes(p);
}

/**
 * Filter a caller's requested field list down to the allowlist, de-duplicated
 * and order-stable. Unknown fields are dropped silently (never trusted).
 */
export function normalizeSelectedFields(fields: readonly string[]): OutreachField[] {
  const seen = new Set<string>();
  const out: OutreachField[] = [];
  for (const f of fields) {
    if (isAllowedOutreachField(f) && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/**
 * Collapse internal whitespace and trim. Deterministic normalization applied to
 * every fact value before it appears in copy.
 */
export function sanitizeFactValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Deterministically render a first-contact outreach draft from approved facts.
 *
 * The copy is intentionally plain and factual: it introduces the sender, states
 * only the provided facts about the recipient's business, and offers to help —
 * with zero fabricated claims. It is safe to send to any channel.
 */
export function renderFirstContactDraft(
  input: OutreachRenderInput,
): OutreachRenderResult {
  const selected = normalizeSelectedFields(input.selectedFields);

  // Collect usable facts (must be present AND approved provenance) in the
  // stable allowlist order. Track requested-but-unavailable fields for audit.
  const usable: FactReference[] = [];
  const unavailableFields: OutreachField[] = [];

  for (const field of OUTREACH_ALLOWED_FIELDS) {
    if (!selected.includes(field)) continue;
    const fact = input.facts[field];
    if (
      !fact ||
      typeof fact.value !== "string" ||
      sanitizeFactValue(fact.value) === "" ||
      !isApprovedProvenance(fact.provenance)
    ) {
      unavailableFields.push(field);
      continue;
    }
    usable.push({
      fieldName: field,
      value: sanitizeFactValue(fact.value),
      provenance: fact.provenance,
      sourceId: fact.sourceId ?? null,
    });
  }

  const businessNameFact = usable.find((f) => f.fieldName === "businessName");
  if (!businessNameFact) {
    return {
      ok: false,
      reason: "missing_business_name",
      unavailableFields,
    };
  }
  if (usable.length === 0) {
    return { ok: false, reason: "no_usable_facts", unavailableFields };
  }

  const businessName = businessNameFact.value;
  const by = (field: OutreachField): string | null =>
    usable.find((f) => f.fieldName === field)?.value ?? null;

  const category = by("category");
  const city = by("city");
  const region = by("region");
  const services = by("services");
  const websiteUrl = by("websiteUrl");
  const description = by("description");

  // ── Subject ──────────────────────────────────────────────────────────────
  const subject = `A quick note for ${businessName}`;

  // ── Body ─────────────────────────────────────────────────────────────────
  const senderName = input.senderName
    ? sanitizeFactValue(input.senderName)
    : null;

  const lines: string[] = [];
  lines.push(`Hi ${businessName} team,`);
  lines.push("");

  // Opening restates only provided facts — never invents anything.
  const locationPhrase = city
    ? region
      ? `${city}, ${region}`
      : city
    : region;

  const openingBits: string[] = [];
  if (category) openingBits.push(`your work in ${category.toLowerCase()}`);
  if (locationPhrase) openingBits.push(`your presence in ${locationPhrase}`);

  if (openingBits.length > 0) {
    lines.push(
      `I came across ${businessName} and noticed ${openingBits.join(" and ")}.`,
    );
  } else {
    lines.push(`I came across ${businessName} and wanted to reach out.`);
  }

  if (description) {
    lines.push("");
    lines.push(`You describe the business as: "${description}".`);
  }

  if (services) {
    lines.push("");
    lines.push(`I understand you offer: ${services}.`);
  }

  if (websiteUrl) {
    lines.push("");
    lines.push(`I took a look at your site (${websiteUrl}).`);
  }

  lines.push("");
  lines.push(
    "I help local businesses put a clear, professional website in front of their customers. If that's useful, I'd be glad to share a few ideas — no obligation.",
  );
  lines.push("");
  lines.push("Would you be open to a short conversation?");
  lines.push("");
  lines.push("Kind regards,");
  lines.push(senderName ?? "The SiteForge team");

  const body = lines.join("\n");

  return { ok: true, subject, body, factSnapshot: usable };
}

/**
 * Build a WhatsApp provider-not-configured result. WhatsApp never sends; this
 * gives an honest, stable state so callers can report it consistently.
 */
export function whatsappNotConfiguredState(): {
  channel: "whatsapp";
  provider: "whatsapp";
  configured: false;
  state: "provider_not_configured";
  message: string;
} {
  return {
    channel: "whatsapp",
    provider: "whatsapp",
    configured: false,
    state: "provider_not_configured",
    message:
      "WhatsApp outreach is not configured. No message was sent and no provider action was taken.",
  };
}
