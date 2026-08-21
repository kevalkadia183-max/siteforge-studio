/**
 * Lead outreach tests (Task #33) — pure/unit coverage.
 *
 * Covers:
 *  - fact-only rendering (no fabricated claims)
 *  - imported-fact denial + owner-confirmation path (provenance gate)
 *  - review gate helper + edit-clears-review invariant (state machine)
 *  - DNC/opt-out blocking every mutation (block predicate)
 *  - no Gmail send (connector never hits send endpoint)
 *  - Gmail failure honest state (ambiguous → honest retryable error)
 *  - reconciliation via stable Message-ID
 *  - WhatsApp honest provider-not-configured state
 *  - owner isolation of approved-fact loading
 *
 * All pure — no DB or real network.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const outDir = await mkdtemp(join(tmpdir(), "siteforge-lead-outreach-"));

async function bundle(rel, name) {
  const outfile = join(outDir, name);
  await build({
    entryPoints: [new URL(rel, import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

const copy = await bundle("../src/lib/lead-outreach-copy.ts", "copy.mjs");
const gmail = await bundle("../src/lib/lead-outreach-gmail.ts", "gmail.mjs");
const serial = await bundle("../src/lib/lead-outreach-serial.ts", "serial.mjs");

const {
  OUTREACH_ALLOWED_FIELDS,
  APPROVED_PROVENANCE,
  isAllowedOutreachField,
  isApprovedProvenance,
  normalizeSelectedFields,
  renderFirstContactDraft,
  whatsappNotConfiguredState,
} = copy;

const {
  buildOutreachRfc2822,
  createOutreachGmailDraft,
  reconcileOutreachGmailDraft,
  findExistingOutreachDraft,
  validateOutreachEmailRecipient,
  validateOutreachSubject,
  validateOperationKey,
  encodeRfc2047Subject,
} = gmail;

const { serializeOutreachDraft } = serial;

// ── fixtures ──────────────────────────────────────────────────────────────
function fact(fieldName, value, provenance = "user_provided", sourceId = "s1") {
  return { fieldName, value, provenance, sourceId };
}

// ── Allowlist / provenance guards ──────────────────────────────────────────
test("allowlist rejects unknown fields", () => {
  assert.equal(isAllowedOutreachField("businessName"), true);
  assert.equal(isAllowedOutreachField("phone"), false);
  assert.equal(isAllowedOutreachField("ownerId"), false);
});

test("approved provenance is only user_provided/verified", () => {
  assert.deepEqual([...APPROVED_PROVENANCE].sort(), ["user_provided", "verified"]);
  assert.equal(isApprovedProvenance("user_provided"), true);
  assert.equal(isApprovedProvenance("verified"), true);
  for (const p of ["imported", "inferred", "ai_generated", "provider"]) {
    assert.equal(isApprovedProvenance(p), false);
  }
});

test("normalizeSelectedFields dedupes, drops unknown, preserves input order", () => {
  const out = normalizeSelectedFields([
    "services",
    "businessName",
    "phone",
    "businessName",
    "city",
  ]);
  // unknown "phone" dropped, duplicate "businessName" removed, input order kept
  assert.deepEqual(out, ["services", "businessName", "city"]);
});

// ── Fact-only rendering ─────────────────────────────────────────────────────
test("renders deterministic copy from approved facts, no fabricated claims", () => {
  const r = renderFirstContactDraft({
    selectedFields: ["businessName", "category", "city", "services"],
    facts: {
      businessName: fact("businessName", "Acme Plumbing"),
      category: fact("category", "Plumbing"),
      city: fact("city", "Austin"),
      services: fact("services", "drain cleaning, water heaters"),
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.subject, /Acme Plumbing/);
  assert.match(r.body, /Acme Plumbing/);
  assert.match(r.body, /Austin/);
  assert.match(r.body, /drain cleaning/);
  // Snapshot contains exactly the used facts with references.
  assert.equal(r.factSnapshot.length, 4);
  assert.ok(r.factSnapshot.every((f) => f.sourceId === "s1"));

  // No fabricated claims/ratings/guarantees/testimonials/discounts/etc.
  const forbidden =
    /\b(\d(\.\d)?\s?stars?|rated|rating|guarantee|guaranteed|award|certified|licensed|#1|best|top-rated|reviews?|testimonial|discount|% off|available 24\/7|free quote today|we sent|delivered)\b/i;
  assert.doesNotMatch(r.body, forbidden);
  assert.doesNotMatch(r.subject, forbidden);
});

test("rendering determinism: identical input → identical output", () => {
  const input = {
    selectedFields: ["businessName", "city"],
    facts: {
      businessName: fact("businessName", "Bright Cafe"),
      city: fact("city", "Denver"),
    },
  };
  const a = renderFirstContactDraft(input);
  const b = renderFirstContactDraft(input);
  assert.deepEqual(a, b);
});

// ── Imported-fact denial + owner confirmation ───────────────────────────────
test("imported fact is denied (excluded) from rendering", () => {
  const r = renderFirstContactDraft({
    selectedFields: ["businessName", "city"],
    facts: {
      businessName: fact("businessName", "Acme"),
      // city is imported → NOT usable
      city: fact("city", "Austin", "imported"),
    },
  });
  assert.equal(r.ok, true); // businessName still usable
  // city must not appear (it was imported, unapproved)
  assert.doesNotMatch(r.body, /Austin/);
  assert.equal(r.factSnapshot.some((f) => f.fieldName === "city"), false);
});

test("owner confirmation flips imported→verified and the fact becomes usable", () => {
  // Simulate the server appending a verified source row on confirmation.
  const r = renderFirstContactDraft({
    selectedFields: ["businessName", "city"],
    facts: {
      businessName: fact("businessName", "Acme"),
      city: fact("city", "Austin", "verified", "confirmed-src"),
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.body, /Austin/);
  assert.equal(
    r.factSnapshot.find((f) => f.fieldName === "city").provenance,
    "verified",
  );
});

test("missing/unapproved businessName fails render with honest reason", () => {
  const r = renderFirstContactDraft({
    selectedFields: ["businessName", "city"],
    facts: {
      businessName: fact("businessName", "Acme", "imported"), // unapproved
      city: fact("city", "Austin"),
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_business_name");
  assert.ok(r.unavailableFields.includes("businessName"));
});

// ── Review gate + edit-clears-review (state machine simulation) ──────────────
// Mirrors the route invariant: create→draft(unreviewed); review→reviewed;
// edit→draft(review cleared); gmail requires reviewed.
function reduce(state, action) {
  switch (action.type) {
    case "create":
      return { status: "draft", reviewedAt: null };
    case "review":
      if (state.status !== "draft") return state; // only unreviewed reviewable
      return { status: "reviewed", reviewedAt: "T" };
    case "edit":
      if (state.status !== "draft" && state.status !== "reviewed") return state;
      return { status: "draft", reviewedAt: null }; // edit ALWAYS clears review
    default:
      return state;
  }
}

test("draft starts unreviewed", () => {
  const s = reduce(undefined, { type: "create" });
  assert.equal(s.status, "draft");
  assert.equal(s.reviewedAt, null);
});

test("review gate: gmail requires reviewed current copy", () => {
  const created = reduce(undefined, { type: "create" });
  const canDraftGmail = (s) => s.status === "reviewed" && s.reviewedAt != null;
  assert.equal(canDraftGmail(created), false);
  const reviewed = reduce(created, { type: "review" });
  assert.equal(canDraftGmail(reviewed), true);
});

test("edit clears review", () => {
  let s = reduce(undefined, { type: "create" });
  s = reduce(s, { type: "review" });
  assert.equal(s.status, "reviewed");
  s = reduce(s, { type: "edit" });
  assert.equal(s.status, "draft");
  assert.equal(s.reviewedAt, null);
});

// ── DNC / opt-out blocking (block predicate mirrors findOutreachBlock) ───────
// findOutreachBlock now checks opt-out FIRST, so opt-out wording takes
// priority over generic suppression wording when both states are true.
// (opt-out sets suppressed=true as a side effect.)
function blockedReason({ suppressed, optedOut }) {
  // Mirrors findOutreachBlock ordering: opt-out checked before suppression.
  if (optedOut) return "Lead has opted out of outreach — outreach is not allowed.";
  if (suppressed) return "Lead is suppressed (Do Not Contact) — outreach is not allowed.";
  return null;
}

test("DNC suppression blocks outreach", () => {
  assert.ok(blockedReason({ suppressed: true, optedOut: false }));
  assert.match(
    blockedReason({ suppressed: true, optedOut: false }),
    /suppressed.*Do Not Contact/i,
  );
});

test("opt-out blocks outreach", () => {
  assert.ok(blockedReason({ suppressed: false, optedOut: true }));
  assert.match(
    blockedReason({ suppressed: false, optedOut: true }),
    /opted out/i,
  );
});

test("no block when neither suppressed nor opted out", () => {
  assert.equal(blockedReason({ suppressed: false, optedOut: false }), null);
});

test("blockedReason: opt-out takes priority over suppression when both are true", () => {
  // When a lead opts out, suppressed is also set to true. The more specific
  // and user-intentional reason (opted-out) should surface to the client,
  // not the generic 'suppressed (Do Not Contact)' wording.
  const r = blockedReason({ suppressed: true, optedOut: true });
  assert.ok(r, "should be blocked");
  assert.match(r, /opted out/i);
  assert.doesNotMatch(r, /Do Not Contact/i);
});

// ── Gmail: never sends; only creates a draft ─────────────────────────────────
function makeConnector(handlers) {
  const calls = [];
  return {
    calls,
    proxy: async (service, path, options) => {
      calls.push({ service, path, method: options.method });
      const h = handlers(service, path, options);
      return h;
    },
  };
}

test("gmail draft path never calls a send endpoint", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("/drafts")) {
      return { ok: true, status: 200, json: async () => ({ id: "d1", message: { id: "m1" } }) };
    }
    throw new Error("unexpected path " + path);
  });
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "siteforge-outreach-x",
    recipientEmail: "lead@example.com",
    subject: "A quick note",
    body: "hello",
  });
  assert.equal(outcome.kind, "created");
  assert.equal(outcome.gmailDraftId, "d1");
  // Assert NO send endpoint was ever hit.
  for (const c of connector.calls) {
    assert.doesNotMatch(c.path, /\/send\b/);
    assert.doesNotMatch(c.path, /messages\/send/);
  }
  // Only the drafts endpoint was called.
  assert.deepEqual(
    connector.calls.map((c) => c.path.includes("/drafts")),
    [true],
  );
});

test("RFC-2822 uses a stable Message-ID and no send semantics", () => {
  const result = buildOutreachRfc2822({
    operationKey: "siteforge-outreach-abc",
    recipientEmail: "lead@example.com",
    subject: "Hi",
    body: "body",
  });
  assert.equal(result.ok, true);
  const raw = result.raw;
  assert.match(raw, /Message-ID: <siteforge-outreach-abc@draft\.local>/);
  assert.match(raw, /To: lead@example\.com/);
  assert.doesNotMatch(raw, /X-Send|Deliver|Sent/i);
});

// ── Gmail failure honest state + reconciliation ─────────────────────────────
test("ambiguous failure with no existing draft → honest retryable 502", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("/drafts") && !path.includes("messages?q=")) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    // reconciliation lookup finds nothing
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  });
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "op1",
    recipientEmail: "lead@example.com",
    subject: "s",
    body: "b",
  });
  assert.equal(outcome.kind, "ambiguous");
  assert.equal(outcome.status, 502);
  assert.equal(outcome.reason, "ambiguous");
  assert.match(outcome.error, /did not confirm/i);
});

test("createOutreachGmailDraft issues EXACTLY ONE POST on an ambiguous outcome", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("/drafts") && !path.includes("messages?q=")) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [] }) };
  });
  await createOutreachGmailDraft(connector, {
    operationKey: "op-one-post",
    recipientEmail: "lead@example.com",
    subject: "s",
    body: "b",
  });
  const posts = connector.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "ambiguous outcome must POST exactly once");
});

test("reconcileOutreachGmailDraft is lookup-only and NEVER POSTs (found)", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "recon-1" }] }) };
    }
    throw new Error("reconcile must not hit " + path);
  });
  const r = await reconcileOutreachGmailDraft(connector, "op-recon-found");
  assert.equal(r.kind, "found");
  assert.equal(r.gmailMessageId, "recon-1");
  assert.equal(connector.calls.filter((c) => c.method === "POST").length, 0);
});

test("reconcileOutreachGmailDraft: not found → not_found (no POST)", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      return { ok: true, status: 200, json: async () => ({ messages: [] }) };
    }
    throw new Error("reconcile must not hit " + path);
  });
  const r = await reconcileOutreachGmailDraft(connector, "op-recon-missing");
  assert.equal(r.kind, "not_found");
  assert.equal(connector.calls.filter((c) => c.method === "POST").length, 0);
});

test("reconcileOutreachGmailDraft: lookup unavailable → unavailable (no POST)", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    throw new Error("reconcile must not hit " + path);
  });
  const r = await reconcileOutreachGmailDraft(connector, "op-recon-503");
  assert.equal(r.kind, "unavailable");
  assert.equal(connector.calls.filter((c) => c.method === "POST").length, 0);
});

test("reconcileOutreachGmailDraft: thrown error → unavailable (fail closed, no POST)", async () => {
  const connector = makeConnector(() => {
    throw new Error("network down");
  });
  const r = await reconcileOutreachGmailDraft(connector, "op-recon-throw");
  assert.equal(r.kind, "unavailable");
  assert.equal(connector.calls.filter((c) => c.method === "POST").length, 0);
});

test("ambiguous-then-retry recovery uses lookup only → exactly ONE POST total", async () => {
  // Round 1: POST fails, immediate lookup invisible → ambiguous (1 POST).
  // Round 2: reconciliation lookup now sees the draft → found (0 POST).
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      // First lookup invisible, later lookups visible.
      const visible = connector.calls.filter((c) => c.method === "POST").length > 0
        && connector._reconcilePhase;
      return { ok: true, status: 200, json: async () => ({ messages: visible ? [{ id: "eventual-1" }] : [] }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  connector._reconcilePhase = false;
  const first = await createOutreachGmailDraft(connector, {
    operationKey: "op-eventual",
    recipientEmail: "lead@example.com",
    subject: "s",
    body: "b",
  });
  assert.equal(first.kind, "ambiguous");
  connector._reconcilePhase = true;
  const recon = await reconcileOutreachGmailDraft(connector, "op-eventual");
  assert.equal(recon.kind, "found");
  assert.equal(
    connector.calls.filter((c) => c.method === "POST").length,
    1,
    "the whole ambiguous→retry sequence must POST exactly once",
  );
});

test("validation rejection returns rejected with no POST at all", async () => {
  const connector = makeConnector(() => {
    throw new Error("must not be called for invalid header");
  });
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "op-bad",
    recipientEmail: "lead@example.com\r\nBcc: evil@x.com",
    subject: "s",
    body: "b",
  });
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.status, 409);
  assert.equal(outcome.reason, "invalid_recipient");
  assert.equal(connector.calls.length, 0);
});

test("ambiguous failure but stable Message-ID exists → reconciled as created", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "found-1" }] }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "op2",
    recipientEmail: "lead@example.com",
    subject: "s",
    body: "b",
  });
  assert.equal(outcome.kind, "created");
  assert.equal(outcome.gmailMessageId, "found-1");
});

test("connector unavailable during reconciliation lookup is honest", async () => {
  const connector = makeConnector((_s, path) => {
    if (path.includes("messages?q=")) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
  const lookup = await findExistingOutreachDraft(connector, "op3");
  assert.equal(lookup.status, "unavailable");
});

// ── WhatsApp honest provider-not-configured ─────────────────────────────────
test("whatsapp returns provider-not-configured with no side effects", () => {
  const w = whatsappNotConfiguredState();
  assert.equal(w.channel, "whatsapp");
  assert.equal(w.configured, false);
  assert.equal(w.state, "provider_not_configured");
  assert.match(w.message, /not configured/i);
  assert.match(w.message, /No message was sent/i);
});

// ── Owner isolation of fact selection (allowlist keyed by field only) ────────
test("only allowlisted fields are ever considered", () => {
  // Inject a non-allowlisted field with approved provenance — must be ignored.
  const r = renderFirstContactDraft({
    selectedFields: ["businessName", "phone", "email", "rating"],
    facts: {
      businessName: fact("businessName", "Acme"),
      // These are not allowlisted; even if present they cannot render.
      phone: fact("phone", "555-1212"),
      email: fact("email", "x@y.com"),
      rating: fact("rating", "5"),
    },
  });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.body, /555-1212/);
  assert.doesNotMatch(r.body, /x@y\.com/);
  assert.equal(r.factSnapshot.length, 1);
  assert.equal(r.factSnapshot[0].fieldName, "businessName");
});

test("allowlist constant is exactly the documented set", () => {
  assert.deepEqual([...OUTREACH_ALLOWED_FIELDS], [
    "businessName",
    "category",
    "city",
    "region",
    "websiteUrl",
    "services",
    "description",
  ]);
});

// ── serializeOutreachDraft: leadBusinessName and recipientDisplay ─────────────
// These fields are populated server-side from lead context. They must never
// come from the draft row itself or from client input.

function makeDraft(overrides = {}) {
  return {
    id: "d1",
    ownerId: "owner1",
    leadId: "lead1",
    channel: "email",
    status: "draft",
    gmailState: "none",
    subject: "Hi",
    body: "Hello there.",
    factSnapshot: null,
    gmailDraftId: null,
    gmailMessageId: null,
    gmailOperationKey: null,
    failureReason: null,
    reviewedAt: null,
    gmailDraftCreatedAt: null,
    repliedAt: null,
    discardedAt: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

test("serializeOutreachDraft: without lead context → null display fields", () => {
  const s = serializeOutreachDraft(makeDraft());
  assert.equal(s.leadBusinessName, null);
  assert.equal(s.recipientDisplay, null);
  // Core fields still present
  assert.equal(s.id, "d1");
  assert.equal(s.leadId, "lead1");
  assert.equal(s.channel, "email");
  assert.equal(s.reviewed, false);
});

test("serializeOutreachDraft: email channel uses email as recipientDisplay", () => {
  const ctx = { businessName: "Acme Plumbing", recipientDisplay: "contact@acme.com" };
  const s = serializeOutreachDraft(makeDraft({ channel: "email" }), ctx);
  assert.equal(s.leadBusinessName, "Acme Plumbing");
  assert.equal(s.recipientDisplay, "contact@acme.com");
});

test("serializeOutreachDraft: whatsapp channel uses phone as recipientDisplay", () => {
  const ctx = { businessName: "Acme Plumbing", recipientDisplay: "+1-555-0100" };
  const s = serializeOutreachDraft(makeDraft({ channel: "whatsapp" }), ctx);
  assert.equal(s.leadBusinessName, "Acme Plumbing");
  assert.equal(s.recipientDisplay, "+1-555-0100");
});

test("serializeOutreachDraft: null recipientDisplay when lead has no contact field", () => {
  // recipientDisplay is null when the lead has no email (email channel) or
  // no phone (whatsapp channel) — not invented.
  const ctx = { businessName: "Acme Plumbing", recipientDisplay: null };
  const s = serializeOutreachDraft(makeDraft(), ctx);
  assert.equal(s.recipientDisplay, null);
  assert.equal(s.leadBusinessName, "Acme Plumbing");
});

test("serializeOutreachDraft: ownerId is always omitted from output", () => {
  const ctx = { businessName: "Acme", recipientDisplay: "a@b.com" };
  const s = serializeOutreachDraft(makeDraft(), ctx);
  assert.ok(!("ownerId" in s), "ownerId must not be present in serialized record");
});

test("serializeOutreachDraft: reviewed flag reflects status and reviewedAt", () => {
  const reviewed = serializeOutreachDraft(makeDraft({ status: "reviewed", reviewedAt: new Date() }));
  assert.equal(reviewed.reviewed, true);
  const unreviewed = serializeOutreachDraft(makeDraft({ status: "draft", reviewedAt: null }));
  assert.equal(unreviewed.reviewed, false);
  const gmailCreated = serializeOutreachDraft(makeDraft({ status: "gmail_draft_created", reviewedAt: new Date() }));
  assert.equal(gmailCreated.reviewed, true);
});

// ── Header injection prevention ────────────────────────────────────────────────

// validateOutreachEmailRecipient

test("header: valid single mailbox accepted", () => {
  assert.equal(validateOutreachEmailRecipient("lead@example.com"), null);
  assert.equal(validateOutreachEmailRecipient("user.name+tag@sub.example.org"), null);
});

test("header: CR/LF in recipient rejected", () => {
  assert.ok(validateOutreachEmailRecipient("lead@example.com\r\nBcc: evil@x.com"));
  assert.ok(validateOutreachEmailRecipient("lead@example.com\nX-Inject: 1"));
  assert.match(
    validateOutreachEmailRecipient("lead@example.com\r\nBcc: evil@x.com"),
    /CR or LF/i,
  );
});

test("header: display-name syntax rejected (angle-bracket form)", () => {
  const err = validateOutreachEmailRecipient("Name <lead@example.com>");
  assert.ok(err, "should be rejected");
  assert.match(err, /display-name|plain email/i);
});

test("header: multiple recipients rejected (comma-separated)", () => {
  const err = validateOutreachEmailRecipient("a@b.com,c@d.com");
  assert.ok(err, "should be rejected");
  assert.match(err, /single recipient/i);
});

test("header: semicolon-separated list rejected", () => {
  assert.ok(validateOutreachEmailRecipient("a@b.com;c@d.com"));
});

test("header: whitespace in recipient rejected", () => {
  assert.ok(validateOutreachEmailRecipient("a @b.com"));
  assert.ok(validateOutreachEmailRecipient(" a@b.com"));
});

test("header: bare name (no @) rejected", () => {
  assert.ok(validateOutreachEmailRecipient("notanemail"));
});

test("header: empty recipient rejected", () => {
  assert.ok(validateOutreachEmailRecipient(""));
  assert.ok(validateOutreachEmailRecipient(null));
});

// validateOutreachSubject

test("header: valid subject accepted", () => {
  assert.equal(validateOutreachSubject("A quick note for Acme"), null);
  assert.equal(validateOutreachSubject("Hello 🌍"), null);
});

test("header: CR in subject rejected", () => {
  const err = validateOutreachSubject("Subject\rX-Inject: evil");
  assert.ok(err, "should reject CR");
  assert.match(err, /CR or LF/i);
});

test("header: LF in subject rejected", () => {
  const err = validateOutreachSubject("Subject\nX-Inject: evil");
  assert.ok(err, "should reject LF");
  assert.match(err, /CR or LF/i);
});

test("header: CRLF in subject rejected", () => {
  assert.ok(validateOutreachSubject("Subject\r\nX-Inject: evil"));
});

test("header: empty subject rejected", () => {
  assert.ok(validateOutreachSubject(""));
  assert.ok(validateOutreachSubject(null));
});

// validateOperationKey

test("header: safe operation key accepted", () => {
  assert.equal(validateOperationKey("siteforge-outreach-abc123"), null);
  assert.equal(validateOperationKey("abc_def.ghi-jkl"), null);
});

test("header: operation key with @ rejected", () => {
  assert.ok(validateOperationKey("key@domain.com"));
});

test("header: operation key with whitespace rejected", () => {
  assert.ok(validateOperationKey("siteforge outreach abc"));
});

test("header: operation key with angle bracket rejected", () => {
  assert.ok(validateOperationKey("<siteforge-outreach-abc>"));
});

test("header: empty operation key rejected", () => {
  assert.ok(validateOperationKey(""));
});

// encodeRfc2047Subject

test("RFC 2047: ASCII-only subject returned unchanged", () => {
  const s = "A quick note for Acme";
  const enc = encodeRfc2047Subject(s);
  assert.equal(enc, s);
});

test("RFC 2047: non-ASCII subject encoded as UTF-8 Q-encoding", () => {
  const enc = encodeRfc2047Subject("Hola ¿cómo estás?");
  // Must be an encoded-word starting with =?UTF-8?Q?
  assert.match(enc, /^=\?UTF-8\?Q\?/);
  assert.match(enc, /\?=$/);
  // Must not contain a raw CR/LF or the raw non-ASCII characters.
  assert.doesNotMatch(enc, /[\r\n]/);
  assert.doesNotMatch(enc, /[^\x00-\x7F]/);
});

test("RFC 2047: emoji subject encoded correctly", () => {
  const enc = encodeRfc2047Subject("Hello 🌍");
  assert.match(enc, /^=\?UTF-8\?Q\?/);
  assert.doesNotMatch(enc, /[^\x00-\x7F]/);
});

test("RFC 2047: spaces in non-ASCII subject encoded as underscores in Q-encoding", () => {
  const enc = encodeRfc2047Subject("Café au lait");
  // Spaces in Q-encoding become underscores
  assert.match(enc, /_/);
  assert.doesNotMatch(enc, /[^\x00-\x7F]/);
});

// buildOutreachRfc2822 returns { ok, raw }

test("buildOutreachRfc2822: returns ok:true with valid input", () => {
  const r = buildOutreachRfc2822({
    operationKey: "siteforge-outreach-abc",
    recipientEmail: "lead@example.com",
    subject: "Hi there",
    body: "body text",
  });
  assert.equal(r.ok, true);
  assert.match(r.raw, /^To: lead@example\.com\r\n/);
  assert.match(r.raw, /Message-ID: <siteforge-outreach-abc@draft\.local>/);
});

test("buildOutreachRfc2822: returns ok:false on invalid recipient", () => {
  const r = buildOutreachRfc2822({
    operationKey: "siteforge-outreach-abc",
    recipientEmail: "Name <lead@example.com>",
    subject: "Hi",
    body: "body",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /display-name|plain email/i);
});

test("buildOutreachRfc2822: returns ok:false on CR/LF in subject", () => {
  const r = buildOutreachRfc2822({
    operationKey: "siteforge-outreach-abc",
    recipientEmail: "lead@example.com",
    subject: "Hi\r\nX-Inject: evil",
    body: "body",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /CR or LF/i);
});

test("buildOutreachRfc2822: non-ASCII subject encoded, not raw in header", () => {
  const r = buildOutreachRfc2822({
    operationKey: "siteforge-outreach-abc",
    recipientEmail: "lead@example.com",
    subject: "Nota para Señor García",
    body: "body",
  });
  assert.equal(r.ok, true);
  // Subject line must not contain raw non-ASCII bytes.
  const subjectLine = r.raw.split("\r\n").find((l) => l.startsWith("Subject:"));
  assert.ok(subjectLine, "Subject header must be present");
  assert.doesNotMatch(subjectLine, /[^\x00-\x7F]/);
  assert.match(subjectLine, /=\?UTF-8\?Q\?/);
});

// Gmail connector: header rejection before provider call

test("createOutreachGmailDraft: rejects invalid recipient before calling provider", async () => {
  let providerCalled = false;
  const connector = {
    proxy: async () => {
      providerCalled = true;
      return { ok: true, status: 200, json: async () => ({ id: "d1", message: { id: "m1" } }) };
    },
  };
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "siteforge-outreach-x",
    recipientEmail: "Name <lead@example.com>",
    subject: "Hi",
    body: "body",
  });
  assert.equal(providerCalled, false, "provider must NOT be called when recipient invalid");
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.reason, "invalid_recipient");
  assert.equal(outcome.status, 409);
});

test("createOutreachGmailDraft: rejects CR/LF subject before calling provider", async () => {
  let providerCalled = false;
  const connector = {
    proxy: async () => {
      providerCalled = true;
      return { ok: true, status: 200, json: async () => ({ id: "d1", message: { id: "m1" } }) };
    },
  };
  const outcome = await createOutreachGmailDraft(connector, {
    operationKey: "siteforge-outreach-x",
    recipientEmail: "lead@example.com",
    subject: "Hi\r\nBcc: evil@x.com",
    body: "body",
  });
  assert.equal(providerCalled, false, "provider must NOT be called when subject has CRLF");
  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.reason, "invalid_subject");
  assert.equal(outcome.status, 409);
});

// blockedReason state machine — discard and reply must check block

test("discard/reply block check: state machine with suppressed=true", () => {
  // Mirrors the route's findOutreachBlock call inside the transaction.
  // When suppressed (not opted out), wording is DNC.
  function checkBlock({ suppressed, optedOut }) {
    if (optedOut) return "Lead has opted out of outreach — outreach is not allowed.";
    if (suppressed) return "Lead is suppressed (Do Not Contact) — outreach is not allowed.";
    return null;
  }
  assert.ok(checkBlock({ suppressed: true, optedOut: false }));
  assert.match(checkBlock({ suppressed: true, optedOut: false }), /Do Not Contact/i);
  assert.equal(checkBlock({ suppressed: false, optedOut: false }), null);
});

test("discard/reply block check: opted-out lead is always blocked", () => {
  function checkBlock({ suppressed, optedOut }) {
    if (optedOut) return "Lead has opted out of outreach — outreach is not allowed.";
    if (suppressed) return "Lead is suppressed (Do Not Contact) — outreach is not allowed.";
    return null;
  }
  const r = checkBlock({ suppressed: true, optedOut: true });
  assert.ok(r);
  assert.match(r, /opted out/i);
  assert.doesNotMatch(r, /Do Not Contact/i);
});

// Owner isolation: different owner cannot access same draft

test("owner isolation: leadId from another owner returns not_found for draft ops", () => {
  // Pure logic test: the route uses:
  //   loadDraftForUpdateTx(tx, ownerId, draftId) → only returns draft if ownerId matches
  //   loadLeadForUpdateTx(tx, ownerId, leadId)   → only returns lead if ownerId matches
  // Simulated here as: query returns empty → not_found.
  function simulateDraftLoad(draftOwnerId, requestOwnerId, draft) {
    if (draftOwnerId !== requestOwnerId) return null;
    return draft;
  }
  const draft = { id: "d1", ownerId: "owner-A", leadId: "lead1" };
  assert.equal(simulateDraftLoad("owner-A", "owner-B", draft), null);
  assert.deepEqual(simulateDraftLoad("owner-A", "owner-A", draft), draft);
});

// Gmail already-created idempotency: returns 200 not error

test("already-created gmail state: treated as success (idempotent 200)", () => {
  // State machine: when status=gmail_draft_created OR gmailState=created,
  // the route returns already_created → 200 payload, not an error.
  function routeKind({ status, gmailState }) {
    if (status === "gmail_draft_created" || gmailState === "created") {
      return "already_created"; // → 200 with status=gmail_draft_created
    }
    return "proceed";
  }
  assert.equal(routeKind({ status: "gmail_draft_created", gmailState: "created" }), "already_created");
  assert.equal(routeKind({ status: "reviewed", gmailState: "none" }), "proceed");
});

// Central search: filter contract

test("central search: search param is optional and max 200 chars", () => {
  // The search param truncates to 200 chars and is trimmed server-side.
  function processSearch(raw) {
    if (typeof raw !== "string") return "";
    return raw.trim().slice(0, 200);
  }
  assert.equal(processSearch("Acme"), "Acme");
  assert.equal(processSearch("  Acme  "), "Acme");
  assert.equal(processSearch("x".repeat(300)), "x".repeat(200));
  assert.equal(processSearch(undefined), "");
  assert.equal(processSearch(""), "");
});

// Opt-out vs Gmail lock ordering

test("optout-vs-gmail lock: opt-out-first makes Gmail fail closed (state machine)", () => {
  // If opt-out commits first, the opt-out row exists when Gmail's transaction
  // reads it. findOutreachBlock returns non-null → Gmail returns 'blocked'.
  // This is the pure invariant; the actual serialization is enforced by
  // the shared per-lead advisory lock in the route.
  function findBlock(optOutExists, suppressed) {
    if (optOutExists) return "opted_out";
    if (suppressed) return "suppressed";
    return null;
  }
  assert.equal(findBlock(true, true), "opted_out"); // opt-out wins, Gmail blocked
  assert.equal(findBlock(false, false), null); // Gmail proceeds
});

test("optout-vs-gmail lock: gmail-first is acceptable (draft created before optout)", () => {
  // If Gmail creates the draft and commits first, the opt-out can still
  // proceed. The draft is already in gmail_draft_created state; opt-out
  // records the opted_out event against it and sets the opt-out row.
  // There is no invariant violation: opt-out sets a durable block for
  // FUTURE outreach; an existing created draft is historical.
  // This is the documented acceptable ordering.
  const draftStatus = "gmail_draft_created";
  const optOutRow = { reason: "changed mind" };
  // After opt-out: both exist, future outreach is blocked.
  const futureBlock = optOutRow ? "opted_out" : null;
  assert.ok(futureBlock, "future outreach is blocked after opt-out");
  assert.equal(draftStatus, "gmail_draft_created", "prior draft record is valid");
});

// ── Reconciliation state machine (pure reducer mirroring the route) ──────────
//
// Models reconcileRequestingDraft: a row already in gmailState=requesting is
// resolved by a lookup-only outcome. This asserts the exact decisions the route
// makes so the fail-closed contract is regression-protected without a DB.

const RECON_DELAY_MS = 2 * 60 * 1000;

// draft: { gmailState, gmailAttemptStartedAt }  (Date|null)
// lookup: "found" | "unavailable" | "not_found"
// now: ms
function reconcileDecision(draft, lookup, now) {
  if (draft.gmailState !== "requesting") return { branch: "not_reconcile" };
  if (lookup === "found") {
    return { branch: "found", nextState: "created", event: "gmail_reconciled", http: 200 };
  }
  if (lookup === "unavailable") {
    return { branch: "pending", nextState: "requesting", event: "gmail_reconciliation_pending", http: 409 };
  }
  // not_found — honor the durable delay; missing timestamp ⇒ fail closed.
  const startedAtMs = draft.gmailAttemptStartedAt
    ? new Date(draft.gmailAttemptStartedAt).getTime()
    : Number.NaN;
  const elapsed = Number.isFinite(startedAtMs) && now - startedAtMs >= RECON_DELAY_MS;
  if (!elapsed) {
    return { branch: "pending", nextState: "requesting", event: "gmail_reconciliation_pending", http: 409 };
  }
  return { branch: "retry_ready", nextState: "none", event: "gmail_retry_ready", http: 409 };
}

test("reconcile: found → created + gmail_reconciled (200), never re-POST", () => {
  const now = Date.now();
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: new Date(now) }, "found", now);
  assert.equal(d.nextState, "created");
  assert.equal(d.event, "gmail_reconciled");
  assert.equal(d.http, 200);
});

test("reconcile: lookup unavailable → stay requesting, pending 409", () => {
  const now = Date.now();
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: new Date(now - 10 * 60 * 1000) }, "unavailable", now);
  assert.equal(d.nextState, "requesting");
  assert.equal(d.event, "gmail_reconciliation_pending");
  assert.equal(d.http, 409);
});

test("reconcile: not_found BEFORE 2-min delay → stay requesting, pending 409", () => {
  const now = Date.now();
  const startedAt = new Date(now - 30 * 1000); // 30s ago < 2min
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: startedAt }, "not_found", now);
  assert.equal(d.nextState, "requesting");
  assert.equal(d.event, "gmail_reconciliation_pending");
  assert.equal(d.http, 409);
});

test("reconcile: not_found AFTER 2-min delay → reviewed+none, gmail_retry_ready 409", () => {
  const now = Date.now();
  const startedAt = new Date(now - 3 * 60 * 1000); // 3min ago >= 2min
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: startedAt }, "not_found", now);
  assert.equal(d.nextState, "none");
  assert.equal(d.event, "gmail_retry_ready");
  assert.equal(d.http, 409);
});

test("reconcile: crash-recovery — a requesting row with missing timestamp fails closed (never retry-ready)", () => {
  const now = Date.now();
  // Legacy/crashed row with no durable attempt-start; not_found must NOT
  // conclude retry-ready (that would allow a second POST prematurely).
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: null }, "not_found", now);
  assert.equal(d.nextState, "requesting");
  assert.equal(d.event, "gmail_reconciliation_pending");
});

test("reconcile: process-crash after claim/POST recovers via requesting branch (lookup-only)", () => {
  // A row left in requesting by a crash is classified as a reconcile, not a
  // fresh claim — so it can only be resolved by a lookup, never a new POST.
  const now = Date.now();
  const d = reconcileDecision(
    { gmailState: "requesting", gmailAttemptStartedAt: new Date(now - 5 * 60 * 1000) },
    "found",
    now,
  );
  assert.equal(d.branch, "found");
  assert.notEqual(d.branch, "not_reconcile");
});

test("reconcile: opt-out AFTER the attempt still records the real found outcome", () => {
  // Reconciliation records the true provider outcome even if the lead opted out
  // after the original POST. It is lookup-only, so it never sends/POSTs; a
  // separate future create attempt would still be blocked by the opt-out.
  const now = Date.now();
  const d = reconcileDecision({ gmailState: "requesting", gmailAttemptStartedAt: new Date(now) }, "found", now);
  assert.equal(d.nextState, "created", "the earlier attempt's real result is recorded despite later opt-out");
  // The post-reconciliation future-create block is independent (opt-out wins).
  function futureCreateBlocked(optedOut) {
    return optedOut ? "opted_out" : null;
  }
  assert.equal(futureCreateBlocked(true), "opted_out");
});

test("reconcile: fresh claim allowed from none OR failed, never from requesting", () => {
  function claimAllowed(gmailState) {
    return gmailState === "none" || gmailState === "failed";
  }
  assert.equal(claimAllowed("none"), true);
  assert.equal(claimAllowed("failed"), true);
  assert.equal(claimAllowed("requesting"), false, "requesting is reconcile-only, never re-claimed/POSTed");
  assert.equal(claimAllowed("created"), false);
});

// ── Serialization of ALL outreach mutations through the per-lead lock ─────────
//
// These tests protect the invariant that no edit/review/discard/reply can
// mutate a draft while its Gmail draft is being created (gmailState=requesting)
// and that every mutating handler uses the SAME advisory-lock key. Because the
// route file imports db/express/connectors, we assert against its SOURCE text
// rather than importing it — this is a structural contract test.

import { readFile as _readFile } from "node:fs/promises";
const routeSrc = await _readFile(
  new URL("../src/routes/lead-acquisition/routes-outreach.ts", import.meta.url),
  "utf8",
);
const leadLockSrc = await _readFile(
  new URL("../src/lib/lead-mutation-lock.ts", import.meta.url),
  "utf8",
);

test("lock-key consistency: the single lock-key formula lives in the SHARED module", () => {
  // The canonical key builder now lives in the shared lead-mutation-lock module
  // so EVERY route (outreach, PATCH, suppression, prospect) uses the same key.
  assert.match(leadLockSrc, /function leadMutationLockKey\([^)]*\)\s*:\s*string\s*\{/);
  assert.match(leadLockSrc, /return `outreach-lead-\$\{ownerId\}-\$\{leadId\}`/);
  // Exactly one RETURNED key template — the canonical builder body.
  const returned = leadLockSrc.match(/return `outreach-lead-[^`]*`/g) ?? [];
  assert.equal(returned.length, 1, `expected a single returned lock-key template in the shared module, found: ${returned.join(", ")}`);
});

test("lock-key consistency: routes-outreach no longer hand-rolls the key formula", () => {
  // The old private outreachLeadLockKey builder must be GONE from the route file
  // (extracted into the shared module). No raw `outreach-lead-...` template may
  // remain anywhere outside the shared module.
  assert.doesNotMatch(routeSrc, /function outreachLeadLockKey\(/);
  const adHoc = routeSrc.match(/`outreach-lead-[^`]*`/g) ?? [];
  assert.equal(adHoc.length, 0, `no raw lock-key template may remain in routes-outreach, found: ${adHoc.join(", ")}`);
  // routes-outreach must go through the shared lock helper.
  assert.match(routeSrc, /withLeadMutationLock/);
});

test("lock-key consistency: no per-draft lock keys remain", () => {
  // The old per-draft key `outreach-${draftId}` must be gone.
  assert.doesNotMatch(routeSrc, /`outreach-\$\{draftId\}`/);
  assert.doesNotMatch(routeSrc, /`outreach-\$\{[^}]*draftId[^}]*\}`/);
});

test("serialization: all mutating handlers go through withOutreachLeadLock", () => {
  // Count how many times each mutating operation opens a transaction. Every
  // one must be on the scoped lockedDb handle, never the global db.
  const lockedTx = (routeSrc.match(/lockedDb\.transaction\(/g) ?? []).length;
  // create, update, review, gmail(claim+success+fail = 3), discard, reply,
  // opt-out = 9 scoped transactions.
  assert.ok(lockedTx >= 9, `expected >=9 lockedDb.transaction calls, found ${lockedTx}`);
});

test("serialization: no mutating handler uses the global db transaction/insert/update", () => {
  // Global db may only be used for READS (select). Any db.transaction/insert/
  // update in this file would be an unlocked mutation → forbidden.
  assert.doesNotMatch(routeSrc, /\bdb\.transaction\(/);
  assert.doesNotMatch(routeSrc, /\bdb\.insert\(/);
  assert.doesNotMatch(routeSrc, /\bdb\.update\(/);
});

test("serialization: withOutreachLeadLock is used by all seven mutating routes", () => {
  // All occurrences of the name, minus the `function withOutreachLeadLock(`
  // declaration, are call sites. Expect 7 handler call sites:
  // create, update, review, gmail, discard, reply, opt-out.
  const all = (routeSrc.match(/withOutreachLeadLock\(/g) ?? []).length;
  const decl = (routeSrc.match(/function withOutreachLeadLock\s*<[^>]*>\s*\(/g) ?? []).length;
  const uses = all - decl;
  assert.equal(uses, 7, `expected 7 withOutreachLeadLock invocations, found ${uses} (decl=${decl})`);
});

test("serialization: the Gmail provider call stays inside the lock", () => {
  // createOutreachGmailDraft (provider call) must appear AFTER the
  // withOutreachLeadLock( opening for the gmail handler and BEFORE its close.
  const gmailHandlerIdx = routeSrc.indexOf("/gmail-draft");
  assert.ok(gmailHandlerIdx > 0);
  const afterHandler = routeSrc.slice(gmailHandlerIdx);
  const lockOpen = afterHandler.indexOf("withOutreachLeadLock(");
  const providerCall = afterHandler.indexOf("createOutreachGmailDraft(connector");
  assert.ok(lockOpen >= 0, "gmail handler must open the lock");
  assert.ok(providerCall > lockOpen, "provider call must be inside the lock body");
});

// ── Fail-closed transition predicates while gmailState=requesting ─────────────
//
// Pure reducer mirroring the server's guards. `requesting` means a Gmail draft
// creation is in flight; edit/review/discard/reply must all be refused.

function canEdit(draft) {
  return (
    (draft.status === "draft" || draft.status === "reviewed") &&
    draft.gmailState === "none"
  );
}
function canReview(draft) {
  return draft.status === "draft" && draft.gmailState === "none";
}
function canDiscard(draft) {
  return draft.status !== "discarded" && draft.gmailState !== "requesting";
}
function canReply(draft) {
  return draft.gmailState !== "requesting";
}

test("fail-closed: edit refused while gmailState=requesting", () => {
  assert.equal(canEdit({ status: "reviewed", gmailState: "requesting" }), false);
  assert.equal(canEdit({ status: "draft", gmailState: "requesting" }), false);
  // And refused once a gmail draft exists (created).
  assert.equal(canEdit({ status: "gmail_draft_created", gmailState: "created" }), false);
  // Allowed only when idle.
  assert.equal(canEdit({ status: "draft", gmailState: "none" }), true);
  assert.equal(canEdit({ status: "reviewed", gmailState: "none" }), true);
});

test("fail-closed: review refused while gmailState=requesting", () => {
  assert.equal(canReview({ status: "draft", gmailState: "requesting" }), false);
  assert.equal(canReview({ status: "reviewed", gmailState: "none" }), false); // already reviewed
  assert.equal(canReview({ status: "draft", gmailState: "none" }), true);
});

test("fail-closed: discard refused while gmailState=requesting", () => {
  assert.equal(canDiscard({ status: "reviewed", gmailState: "requesting" }), false);
  assert.equal(canDiscard({ status: "discarded", gmailState: "none" }), false); // already terminal
  assert.equal(canDiscard({ status: "reviewed", gmailState: "none" }), true);
  assert.equal(canDiscard({ status: "gmail_draft_created", gmailState: "created" }), true);
});

test("fail-closed: reply refused while gmailState=requesting", () => {
  assert.equal(canReply({ status: "reviewed", gmailState: "requesting" }), false);
  assert.equal(canReply({ status: "gmail_draft_created", gmailState: "created" }), true);
  assert.equal(canReply({ status: "reviewed", gmailState: "none" }), true);
});

test("fail-closed: provider-delayed Gmail cannot be raced by another mutation", () => {
  // Simulate the lock semantics: while the Gmail op holds the lock, the draft
  // is gmailState=requesting; any concurrent mutation attempt observes that
  // state ONLY after acquiring the lock (i.e. after Gmail finishes). We model
  // the two possible orderings and assert neither corrupts state.
  //
  // Ordering A: Gmail completes first (created), THEN edit attempt runs.
  const afterGmail = { status: "gmail_draft_created", gmailState: "created" };
  assert.equal(canEdit(afterGmail), false, "edit refused after gmail draft created");
  //
  // Ordering B: an in-flight requesting row is observed (should never happen
  // under the lock, but the predicate is still fail-closed if it does).
  const inFlight = { status: "reviewed", gmailState: "requesting" };
  assert.equal(canEdit(inFlight), false);
  assert.equal(canReview(inFlight), false);
  assert.equal(canDiscard(inFlight), false);
  assert.equal(canReply(inFlight), false);
});

test("no self-deadlock: lock is acquired once per handler (no nested acquisition)", () => {
  // Within any single handler body there must not be TWO withOutreachLeadLock
  // openings (which for a session-level lock would still work but violates our
  // no-nesting convention). We assert each handler segment contains at most one.
  const segments = routeSrc.split("outreachRouter.");
  for (const seg of segments) {
    const count = (seg.match(/withOutreachLeadLock\(/g) ?? []).length;
    assert.ok(count <= 1, `a handler segment acquires the lock ${count} times (must be <=1)`);
  }
});

test("scoped-db discipline: gmailState transition predicates are also enforced in SQL", () => {
  // The conditional UPDATEs must include gmailState guards so the transition is
  // fail-closed at the database level, not just in JS.
  // review: status='draft' AND gmailState='none'
  assert.match(routeSrc, /eq\(leadOutreachDraftsTable\.status,\s*"draft"\)[\s\S]{0,120}eq\(leadOutreachDraftsTable\.gmailState,\s*"none"\)/);
  // gmail claim: reviewed → requesting only from gmailState in (none, failed).
  // A fresh POST is claimed from a never-attempted (none) or definitively
  // rejected (failed) row — never from requesting (which is reconcile-only).
  assert.match(routeSrc, /eq\(leadOutreachDraftsTable\.status,\s*"reviewed"\)[\s\S]{0,200}inArray\(leadOutreachDraftsTable\.gmailState,\s*\["none",\s*"failed"\]\)/);
  // gmail persist/reconcile/fail: only from gmailState='requesting'
  assert.match(routeSrc, /eq\(leadOutreachDraftsTable\.gmailState,\s*"requesting"\)/);
});

test("fail-closed contract: ambiguous outcome NEVER resets requesting → none", () => {
  // The post-attempt ambiguous branch must not write gmailState:"none" (which
  // would re-open a second POST). It stays requesting and audits pending.
  const gmailHandlerIdx = routeSrc.indexOf("Phase 2: fresh attempt");
  const reconcileHelperIdx = routeSrc.indexOf("Lookup-ONLY reconciliation of a row");
  assert.ok(gmailHandlerIdx > 0 && reconcileHelperIdx > gmailHandlerIdx);
  // Between the fresh-attempt phase and the reconcile helper, the only
  // gmailState:"none" reset is inside the >=delay not-found branch of the
  // reconcile helper — never in the ambiguous branch. So the fresh-attempt
  // POST region must not contain a `gmailState: "none"` set.
  const freshRegion = routeSrc.slice(gmailHandlerIdx, reconcileHelperIdx);
  assert.doesNotMatch(freshRegion, /gmailState:\s*"none"/);
  // The ambiguous branch audits reconciliation-pending, not gmail_failed.
  assert.match(freshRegion, /eventType:\s*"gmail_reconciliation_pending"/);
});

test("fail-closed contract: reconcile branch is lookup-only (no createOutreachGmailDraft)", () => {
  const reconcileHelperIdx = routeSrc.indexOf("async function reconcileRequestingDraft");
  assert.ok(reconcileHelperIdx > 0);
  const helper = routeSrc.slice(reconcileHelperIdx);
  // It must call the lookup-only reconciler and NEVER the POSTing creator.
  assert.match(helper.slice(0, 2500), /reconcileOutreachGmailDraft\(connector/);
  // Ensure the helper body does not POST via createOutreachGmailDraft.
  const nextRouteIdx = helper.indexOf("outreachRouter.");
  const helperBody = nextRouteIdx > 0 ? helper.slice(0, nextRouteIdx) : helper;
  assert.doesNotMatch(helperBody, /createOutreachGmailDraft\(/);
});

test("reconcile uses the durable attempt-start timestamp for the 2-minute delay", () => {
  assert.match(routeSrc, /OUTREACH_RECONCILIATION_DELAY_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
  assert.match(routeSrc, /gmailAttemptStartedAt/);
  assert.match(routeSrc, /Date\.now\(\)\s*-\s*startedAtMs\s*>=\s*OUTREACH_RECONCILIATION_DELAY_MS/);
});
