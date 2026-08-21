/**
 * Lead outreach Gmail draft creation — adapted from gmail-draft-approval.
 *
 * This creates a Gmail *draft* (never sends, never marks sent/delivered) for an
 * outreach draft after the owner has reviewed the current copy. It uses:
 *   - a stable, deterministic Message-ID / operation key per outreach draft, so
 *     a repeated attempt reconciles to the same Gmail draft instead of creating
 *     a duplicate;
 *   - a conditional claim (compare-and-set on gmail_state) to serialize attempts;
 *   - reconciliation-safe behavior: on ambiguous/failed responses it returns an
 *     honest error and leaves the record retryable.
 *
 * Header-safety is enforced strictly before any provider call:
 *   - Recipient must be a single RFC 5321 mailbox (no display-name, no list).
 *   - Subject CR/LF characters are always rejected before the claim transaction.
 *   - Subject is encoded as RFC 2047 UTF-8 Q-encoding so non-ASCII is safe.
 *   - Operation key must be header-safe (ASCII printable, no whitespace/specials).
 *
 * The route layer wraps calls in a per-lead advisory lock (see
 * gmail-draft-operation-lock) and supplies the dependencies below. All Gmail
 * side effects go through the injected connector so this module stays testable.
 *
 * Success status is always "gmail_draft_created". Ambiguous/failure is honest
 * and audited by the route (via the returned outcome).
 */

export type OutreachGmailConnector = {
  proxy(
    service: string,
    path: string,
    options: {
      method: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
};

export type OutreachGmailInput = {
  /** Stable operation key (Message-ID local part). Deterministic per draft. */
  operationKey: string;
  /** Recipient email — supplied by the server from the stored lead, not client. */
  recipientEmail: string;
  subject: string;
  body: string;
};

export type OutreachGmailOutcome =
  | { kind: "created"; gmailDraftId: string | null; gmailMessageId: string | null }
  | {
      /**
       * Definitive rejection BEFORE any provider side effect could have taken
       * hold — header/operation-key validation failed. Safe to fail the row
       * (gmail_failed) with no reconciliation needed: no draft was ever POSTed.
       */
      kind: "rejected";
      status: 409;
      error: string;
      reason:
        | "invalid_recipient"
        | "invalid_subject"
        | "invalid_operation_key";
    }
  | {
      /**
       * Ambiguous outcome: the POST did not clearly succeed (non-OK response or
       * thrown error) AND an immediate lookup did not confirm a draft (either
       * not found yet or the lookup itself was unavailable). The provider MAY
       * have created a draft that is not yet visible to search. The caller MUST
       * keep the row in gmailState=requesting and NEVER POST again; recovery is
       * lookup-only via findExistingOutreachDraft.
       */
      kind: "ambiguous";
      status: 502;
      error: string;
      reason: "ambiguous" | "exception";
    };

// ─── Header-safety validators ─────────────────────────────────────────────────

/**
 * CR or LF in any form — injection vector.
 */
const CRLF_RE = /[\r\n]/;

/**
 * Strict single RFC 5321 mailbox:
 *   local@domain  — printable ASCII local, dot-separated domain labels.
 * Rejects: display names ("Name" <addr>), lists (a@b,c@d), bare names,
 * whitespace anywhere, and CR/LF.
 */
const STRICT_EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Operation key: ASCII printable, no whitespace, no angle brackets, no @,
 * no control characters. Must be non-empty and ≤ 128 chars.
 * Used verbatim inside a Message-ID header: <operationKey@draft.local>
 */
const OP_KEY_SAFE_RE = /^[a-zA-Z0-9._\-]{1,128}$/;

/**
 * Validate a recipient email for use in an RFC 2822 To: header.
 *
 * Returns null on success, or a rejection reason string on failure.
 * Never accepts display-name syntax, angle-brackets, commas, or CR/LF.
 */
export function validateOutreachEmailRecipient(email: string): string | null {
  if (!email || typeof email !== "string") return "Recipient email is required.";
  if (CRLF_RE.test(email)) return "Recipient email contains CR or LF — rejected.";
  // Reject display-name forms: contains < or >
  if (email.includes("<") || email.includes(">"))
    return "Recipient must be a plain email address, not a display-name form.";
  // Reject multiple addresses (comma or semicolon separated)
  if (email.includes(",") || email.includes(";"))
    return "Only a single recipient address is allowed.";
  // Reject unquoted whitespace
  if (/\s/.test(email))
    return "Recipient email must not contain whitespace.";
  if (!STRICT_EMAIL_RE.test(email))
    return "Recipient email is not a valid single mailbox address.";
  if (email.length > 320)
    return "Recipient email exceeds maximum length.";
  return null;
}

/**
 * Validate a draft subject for use in an RFC 2822 Subject: header.
 *
 * CR/LF are always rejected regardless of how the subject reached the server
 * (even if bypassing normal API validation). Returns null on success or a
 * rejection reason string on failure.
 */
export function validateOutreachSubject(subject: string): string | null {
  if (!subject || typeof subject !== "string")
    return "Subject is required.";
  if (CRLF_RE.test(subject))
    return "Subject contains CR or LF — rejected to prevent header injection.";
  if (subject.length > 500)
    return "Subject exceeds maximum length.";
  return null;
}

/**
 * Validate that an operation key is header-safe for use inside a Message-ID.
 * Rejects keys with whitespace, angle brackets, @, or non-ASCII.
 */
export function validateOperationKey(key: string): string | null {
  if (!key || typeof key !== "string") return "Operation key is required.";
  if (!OP_KEY_SAFE_RE.test(key))
    return "Operation key contains characters unsafe for a Message-ID header.";
  return null;
}

// ─── RFC 2047 subject encoding ────────────────────────────────────────────────

/**
 * Encode a subject line using RFC 2047 UTF-8 Q-encoding when it contains
 * characters outside printable ASCII (0x21–0x7E, excluding space which uses _).
 * ASCII-only subjects are left unencoded for readability.
 *
 * Q-encoding spec: =?charset?Q?encoded_text?=
 *   - space → _
 *   - characters requiring encoding → =XX (uppercase hex)
 *   - words split at 75-byte encoded limit per RFC 2047 §4.1
 *
 * Pure/testable — no network or DB.
 */
export function encodeRfc2047Subject(subject: string): string {
  // If all characters are printable ASCII (excluding DEL), no encoding needed.
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;

  // Encode the full subject as a single encoded-word.
  // We chunk to stay within the 75-byte encoded-word limit.
  const prefix = "=?UTF-8?Q?";
  const suffix = "?=";
  const maxPayload = 75 - prefix.length - suffix.length; // 60 bytes

  const encoded = encodeQPart(subject);
  // If it fits in one word, emit it directly.
  if (encoded.length <= maxPayload) {
    return `${prefix}${encoded}${suffix}`;
  }
  // Otherwise split at word boundaries, falling back to byte boundaries.
  // We encode the whole thing and split the encoded payload at maxPayload.
  const words: string[] = [];
  let pos = 0;
  while (pos < encoded.length) {
    words.push(`${prefix}${encoded.slice(pos, pos + maxPayload)}${suffix}`);
    pos += maxPayload;
  }
  return words.join(" ");
}

function encodeQPart(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    if (b === 0x20) {
      // space → _
      out += "_";
    } else if (
      (b >= 0x21 && b <= 0x7e && b !== 0x3d && b !== 0x3f && b !== 0x5f)
    ) {
      // printable ASCII (not =, ?, _) → literal
      out += String.fromCharCode(b);
    } else {
      // everything else → =XX
      out += "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// ─── RFC 2822 message builder ─────────────────────────────────────────────────

/**
 * Build the RFC-2822 message with a stable Message-ID. Pure/testable.
 * Never sets any header or content that implies sending or delivery.
 *
 * Validates recipient, subject, and operation key before building.
 * Encodes the subject using RFC 2047 if it contains non-ASCII characters.
 *
 * Returns { ok: true, raw } on success or { ok: false, reason } on rejection.
 */
export function buildOutreachRfc2822(
  input: OutreachGmailInput,
): { ok: true; raw: string } | { ok: false; reason: string } {
  const recipientErr = validateOutreachEmailRecipient(input.recipientEmail);
  if (recipientErr) return { ok: false, reason: recipientErr };

  const subjectErr = validateOutreachSubject(input.subject);
  if (subjectErr) return { ok: false, reason: subjectErr };

  const opKeyErr = validateOperationKey(input.operationKey);
  if (opKeyErr) return { ok: false, reason: opKeyErr };

  const encodedSubject = encodeRfc2047Subject(input.subject);

  const raw = [
    `To: ${input.recipientEmail}`,
    `Subject: ${encodedSubject}`,
    `Message-ID: <${input.operationKey}@draft.local>`,
    `Content-Type: text/plain; charset=UTF-8`,
    "",
    input.body,
  ].join("\r\n");

  return { ok: true, raw };
}

// ─── Gmail draft lookup (reconciliation) ─────────────────────────────────────

/**
 * Look up whether a Gmail draft with our stable Message-ID already exists.
 * Used for reconciliation after an ambiguous attempt.
 */
export async function findExistingOutreachDraft(
  connector: OutreachGmailConnector,
  operationKey: string,
): Promise<
  | { status: "found"; gmailMessageId: string }
  | { status: "not_found" }
  | { status: "unavailable" }
> {
  const query = encodeURIComponent(
    `in:drafts rfc822msgid:${operationKey}@draft.local`,
  );
  const response = await connector.proxy(
    "google-mail",
    `/gmail/v1/users/me/messages?q=${query}&maxResults=1`,
    { method: "GET" },
  );
  if (!response.ok) return { status: "unavailable" };
  const data = (await response.json()) as { messages?: Array<{ id?: string }> };
  const gmailMessageId = data.messages?.[0]?.id;
  return gmailMessageId
    ? { status: "found", gmailMessageId }
    : { status: "not_found" };
}

// ─── Gmail draft creation ─────────────────────────────────────────────────────

/**
 * Attempt to create a Gmail draft for the outreach copy. Never sends. Performs
 * EXACTLY ONE provider POST per call.
 *
 * Behavior:
 *   - Strict header/operation-key validation runs first. On failure returns a
 *     definitive `rejected` outcome with NO provider call and NO side effects.
 *   - Exactly one POST /drafts is issued.
 *   - On a clear success (2xx) returns `created`.
 *   - On any non-OK response or thrown error, an IMMEDIATE single lookup by the
 *     stable Message-ID is attempted:
 *       - if the draft is already visible, returns `created` (the POST did land);
 *       - otherwise (not found yet, or the lookup was itself unavailable)
 *         returns `ambiguous`. The caller MUST keep the row requesting and rely
 *         on lookup-only reconciliation later — it must NEVER POST again.
 *
 * This function issues at most one POST. The later reconciliation path
 * (reconcileOutreachGmailDraft in the route) is lookup-only.
 */
export async function createOutreachGmailDraft(
  connector: OutreachGmailConnector,
  input: OutreachGmailInput,
): Promise<OutreachGmailOutcome> {
  const built = buildOutreachRfc2822(input);
  if (!built.ok) {
    // Determine which field caused the rejection for a precise reason code.
    const recipientErr = validateOutreachEmailRecipient(input.recipientEmail);
    if (recipientErr) {
      return {
        kind: "rejected",
        status: 409,
        error: recipientErr,
        reason: "invalid_recipient",
      };
    }
    const subjectErr = validateOutreachSubject(input.subject);
    if (subjectErr) {
      return {
        kind: "rejected",
        status: 409,
        error: subjectErr,
        reason: "invalid_subject",
      };
    }
    return {
      kind: "rejected",
      status: 409,
      error: built.reason,
      reason: "invalid_operation_key",
    };
  }

  const draftBody: Record<string, unknown> = {
    message: { raw: Buffer.from(built.raw).toString("base64url") },
  };

  const ambiguous = (reason: "ambiguous" | "exception"): OutreachGmailOutcome => ({
    kind: "ambiguous",
    status: 502,
    error:
      "Gmail did not confirm the draft. The attempt is being reconciled — retry shortly; no duplicate will be created.",
    reason,
  });

  try {
    const response = await connector.proxy(
      "google-mail",
      "/gmail/v1/users/me/drafts",
      {
        method: "POST",
        body: draftBody,
        headers: { "Content-Type": "application/json" },
      },
    );

    if (!response.ok) {
      // Immediate single lookup: did the POST actually land despite non-OK?
      const found = await immediateLookup(connector, input.operationKey);
      if (found) return found;
      return ambiguous("ambiguous");
    }

    const data = (await response.json()) as {
      id?: string;
      message?: { id?: string };
    };
    return {
      kind: "created",
      gmailDraftId: data.id ?? null,
      gmailMessageId: data.message?.id ?? null,
    };
  } catch {
    const found = await immediateLookup(connector, input.operationKey);
    if (found) return found;
    return ambiguous("exception");
  }
}

/**
 * A single immediate lookup used only inside createOutreachGmailDraft to decide
 * whether an ambiguous POST actually landed. Returns a `created` outcome if the
 * draft is already visible, otherwise null (treated as ambiguous). Never throws.
 */
async function immediateLookup(
  connector: OutreachGmailConnector,
  operationKey: string,
): Promise<OutreachGmailOutcome | null> {
  try {
    const lookup = await findExistingOutreachDraft(connector, operationKey);
    if (lookup.status === "found") {
      return {
        kind: "created",
        gmailDraftId: null,
        gmailMessageId: lookup.gmailMessageId,
      };
    }
  } catch {
    // fall through — treat as ambiguous
  }
  return null;
}

/**
 * Lookup-ONLY reconciliation of an in-flight (requesting) attempt. Issues a
 * single GET by the stable Message-ID and NEVER POSTs. The route uses this for
 * a row already in gmailState=requesting.
 */
export type OutreachReconcileResult =
  | { kind: "found"; gmailMessageId: string }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function reconcileOutreachGmailDraft(
  connector: OutreachGmailConnector,
  operationKey: string,
): Promise<OutreachReconcileResult> {
  try {
    const lookup = await findExistingOutreachDraft(connector, operationKey);
    if (lookup.status === "found") {
      return { kind: "found", gmailMessageId: lookup.gmailMessageId };
    }
    if (lookup.status === "not_found") {
      return { kind: "not_found" };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
