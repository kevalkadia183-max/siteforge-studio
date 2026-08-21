/**
 * Lead outreach routes.
 *
 * GET    /outreach/drafts                              — central owner list (search, paginate)
 * GET    /leads/:leadId/outreach                       — summary/drafts/history
 * POST   /leads/:leadId/outreach                       — create fact-grounded draft
 * PATCH  /leads/:leadId/outreach/:draftId              — edit subject/body (clears review)
 * POST   /leads/:leadId/outreach/:draftId/review       — mark reviewed
 * POST   /leads/:leadId/outreach/:draftId/gmail-draft  — create Gmail draft (never sends)
 * POST   /leads/:leadId/outreach/:draftId/discard      — discard
 * POST   /leads/:leadId/outreach/:draftId/reply        — mark reply received
 * POST   /leads/:leadId/outreach/opt-out               — opt out (suppresses immediately)
 *
 * ## Security invariants
 * - ownerId is ALWAYS derived from req.sfUserId — never from the client body.
 * - Recipient email, fact values, Gmail result, and provider status are NEVER
 *   taken from the client. The server rereads the stored lead + source rows.
 * - EVERY outreach STATE MUTATION (create, update, review, Gmail, discard,
 *   reply, opt-out) is serialized through ONE per-(owner,lead) session advisory
 *   lock via withOutreachLeadLock(). Inside the lock the handler reloads the
 *   owner-scoped lead FOR UPDATE and calls findOutreachBlock before proceeding.
 *   Because the whole handler (including the Gmail provider call) runs under the
 *   lock, no edit/review/discard/reply can mutate a draft while its Gmail draft
 *   is being created (gmailState=requesting) — so stale pre-edit copy can never
 *   be sent and history can never record contradictory events out of order.
 * - All DB work while the lock is held goes through the SCOPED session handle
 *   (lockedDb) and its transaction — NEVER the global `db`. GET/read handlers
 *   are intentionally unlocked and continue to use `db`.
 * - The lock is acquired ONCE per request at the top of the handler; nested
 *   re-acquisition of the same key is never attempted (no self-deadlock).
 * - WhatsApp never sends; it returns an honest provider-not-configured state.
 * - Gmail path only creates a DRAFT; it never sends or marks sent/delivered.
 * - Because opt-out shares the same lock, opt-out always wins if it commits
 *   first; Gmail-first is acceptable (draft created before opt-out).
 * - Header injection is rejected (CR/LF, multiple addresses, display-name
 *   syntax, non-ASCII-safe operation keys) before any claim or provider call.
 * - Every real action is appended to the immutable outreach history and the
 *   existing lead timeline. Delivery/reply events are never invented.
 */

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  db,
  leadsTable,
  leadOutreachDraftsTable,
  leadOutreachEventsTable,
  leadOutreachOptOutsTable,
  providerSettingsTable,
  type Lead,
  type LeadOutreachDraft,
} from "@workspace/db";
import {
  ListOutreachDraftsQueryParams,
  ListOutreachDraftsResponse,
  GetLeadOutreachParams,
  GetLeadOutreachResponse,
  CreateOutreachDraftParams,
  CreateOutreachDraftBody,
  CreateOutreachDraftResponse,
  UpdateOutreachDraftParams,
  UpdateOutreachDraftBody,
  UpdateOutreachDraftResponse,
  ReviewOutreachDraftParams,
  ReviewOutreachDraftResponse,
  CreateOutreachGmailDraftParams,
  CreateOutreachGmailDraftResponse,
  DiscardOutreachDraftParams,
  DiscardOutreachDraftResponse,
  MarkOutreachReplyParams,
  MarkOutreachReplyResponse,
  OptOutLeadOutreachParams,
  OptOutLeadOutreachBody,
  OptOutLeadOutreachResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { requireFeatureEnabled, newId } from "./helpers";
import {
  appendOutreachEvent,
  applyOutreachOptOut,
  confirmImportedFactSources,
  findOutreachBlock,
  loadApprovedFacts,
  serializeOutreachDraft,
  loadDraftForUpdateTx,
  type LeadContext,
} from "./outreach-ops";
import {
  normalizeSelectedFields,
  renderFirstContactDraft,
  whatsappNotConfiguredState,
  isAllowedOutreachField,
  type OutreachField,
} from "../../lib/lead-outreach-copy";
import {
  createOutreachGmailDraft,
  reconcileOutreachGmailDraft,
  validateOutreachEmailRecipient,
  validateOutreachSubject,
  type OutreachGmailConnector,
} from "../../lib/lead-outreach-gmail";
import {
  withLeadMutationLock,
  type LeadMutationLockedDb,
} from "../../lib/lead-mutation-lock";

export const outreachRouter: IRouter = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Load an owner-scoped lead FOR UPDATE inside a transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadLeadForUpdateTx(tx: any, ownerId: string, leadId: string): Promise<Lead | null> {
  const [lead] = await tx
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
    .limit(1)
    .for("update");
  return lead ?? null;
}

/**
 * Build a LeadContext from a lead row and the draft's channel.
 * recipientDisplay is email for email-channel drafts, phone for whatsapp.
 * Both values come from the stored lead row — never from client input.
 */
function buildLeadContext(lead: Lead, channel: string): LeadContext {
  const recipientDisplay =
    channel === "whatsapp" ? (lead.phone ?? null) : (lead.email ?? null);
  return { businessName: lead.businessName ?? null, recipientDisplay };
}

/**
 * Build a LeadContext map (draftId → LeadContext) for a batch of draft rows
 * by joining against the leads table in one query. Owner-scoped join ensures
 * no cross-owner data leaks.
 */
async function buildLeadContextMap(
  drafts: Array<{ id: string; leadId: string; channel: string }>,
  ownerId: string,
): Promise<Map<string, LeadContext>> {
  const map = new Map<string, LeadContext>();
  if (drafts.length === 0) return map;

  const leadIds = [...new Set(drafts.map((d) => d.leadId))];
  const leads = await db
    .select({ id: leadsTable.id, businessName: leadsTable.businessName, email: leadsTable.email, phone: leadsTable.phone })
    .from(leadsTable)
    .where(and(eq(leadsTable.ownerId, ownerId), inArray(leadsTable.id, leadIds)));

  const leadById = new Map(leads.map((l) => [l.id, l]));
  for (const draft of drafts) {
    const lead = leadById.get(draft.leadId);
    if (!lead) continue;
    const recipientDisplay =
      draft.channel === "whatsapp" ? (lead.phone ?? null) : (lead.email ?? null);
    map.set(draft.id, { businessName: lead.businessName ?? null, recipientDisplay });
  }
  return map;
}

function serializeEvent(e: {
  id: string; draftId: string; eventType: string; performedBy: string | null; occurredAt: Date;
}) {
  return {
    id: e.id,
    draftId: e.draftId,
    eventType: e.eventType as
      | "created" | "edited" | "reviewed" | "discarded"
      | "gmail_requested" | "gmail_created" | "gmail_failed"
      | "reply_marked" | "opted_out",
    performedBy: e.performedBy ?? null,
    occurredAt: e.occurredAt,
  };
}

/**
 * Safety delay before a not-found reconciliation lookup is allowed to conclude
 * that NO Gmail draft exists and transition the row to retry-ready. This gives
 * Gmail's draft search index time to catch up after an ambiguous POST, so we
 * never declare "no draft" (and thus enable a fresh POST) prematurely. Mirrors
 * the receptionist draftReconciliationDelayMs.
 */
const OUTREACH_RECONCILIATION_DELAY_MS = 2 * 60 * 1000;

/**
 * The scoped DB session handle available while the per-lead lock is held.
 * Alias of the shared lead-mutation lock's handle type — outreach handlers use
 * the SAME unified lock (`withLeadMutationLock`) as PATCH/suppression so every
 * mutation to a lead's DNC / recipient / facts / eligibility is serialized with
 * in-flight Gmail draft creation.
 */
type LockedDb = LeadMutationLockedDb;

/**
 * Run `operation` while holding the single per-(owner,lead) lead-mutation lock.
 * Thin, semantically-unchanged alias over the shared `withLeadMutationLock` so
 * existing outreach call sites read unchanged while all routes converge on ONE
 * lock. Do ALL DB work through the scoped `lockedDb` (and its `.transaction()`),
 * never the global `db`. Acquire ONCE per handler; do not nest for the same key.
 */
async function withOutreachLeadLock<T>(
  ownerId: string,
  leadId: string,
  // eslint-disable-next-line no-unused-vars
  operation: (lockedDb: LockedDb) => Promise<T>,
  // eslint-disable-next-line no-unused-vars
  onUnlockFailure?: (error: unknown) => void,
): Promise<T> {
  return withLeadMutationLock(ownerId, leadId, operation, onUnlockFailure);
}

// ─── GET /outreach/drafts ─────────────────────────────────────────────────────

outreachRouter.get(
  "/outreach/drafts",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const query = ListOutreachDraftsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }
    const { channel, status } = query.data;
    const search = typeof query.data.search === "string" ? query.data.search.trim().slice(0, 200) : "";
    const limit = Math.min(100, Math.max(1, query.data.limit ?? 50));
    const offset = Math.max(0, query.data.offset ?? 0);

    if (search) {
      // Search: join outreach drafts → leads and filter by businessName, email,
      // or phone (case-insensitive). Owner-scoped join; count and paginate.
      const likeVal = `%${search}%`;

      // Count with join + search filter.
      const [{ total: totalRaw }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(leadOutreachDraftsTable)
        .innerJoin(
          leadsTable,
          and(
            eq(leadOutreachDraftsTable.leadId, leadsTable.id),
            eq(leadOutreachDraftsTable.ownerId, leadsTable.ownerId),
          ),
        )
        .where(
          and(
            eq(leadOutreachDraftsTable.ownerId, ownerId),
            channel ? eq(leadOutreachDraftsTable.channel, channel) : undefined,
            status ? eq(leadOutreachDraftsTable.status, status) : undefined,
            or(
              ilike(leadsTable.businessName, likeVal),
              ilike(leadsTable.email, likeVal),
              ilike(leadsTable.phone, likeVal),
            ),
          ),
        );
      const total = Number(totalRaw ?? 0);

      // Fetch page with join + search filter.
      const rows = await db
        .select({ draft: leadOutreachDraftsTable, lead: { id: leadsTable.id, businessName: leadsTable.businessName, email: leadsTable.email, phone: leadsTable.phone } })
        .from(leadOutreachDraftsTable)
        .innerJoin(
          leadsTable,
          and(
            eq(leadOutreachDraftsTable.leadId, leadsTable.id),
            eq(leadOutreachDraftsTable.ownerId, leadsTable.ownerId),
          ),
        )
        .where(
          and(
            eq(leadOutreachDraftsTable.ownerId, ownerId),
            channel ? eq(leadOutreachDraftsTable.channel, channel) : undefined,
            status ? eq(leadOutreachDraftsTable.status, status) : undefined,
            or(
              ilike(leadsTable.businessName, likeVal),
              ilike(leadsTable.email, likeVal),
              ilike(leadsTable.phone, likeVal),
            ),
          ),
        )
        .orderBy(desc(leadOutreachDraftsTable.createdAt))
        .limit(limit)
        .offset(offset);

      res.json(
        ListOutreachDraftsResponse.parse({
          drafts: rows.map(({ draft, lead: l }) => {
            const recipientDisplay =
              draft.channel === "whatsapp" ? (l.phone ?? null) : (l.email ?? null);
            return serializeOutreachDraft(draft, {
              businessName: l.businessName ?? null,
              recipientDisplay,
            });
          }),
          total,
          limit,
          offset,
        }),
      );
      return;
    }

    // No search — simple filter on drafts table only.
    const conditions = [eq(leadOutreachDraftsTable.ownerId, ownerId)];
    if (channel) conditions.push(eq(leadOutreachDraftsTable.channel, channel));
    if (status) conditions.push(eq(leadOutreachDraftsTable.status, status));
    const where = and(...conditions)!;

    const [{ count: totalRaw }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadOutreachDraftsTable)
      .where(where);
    const total = Number(totalRaw ?? 0);

    const rows = await db
      .select()
      .from(leadOutreachDraftsTable)
      .where(where)
      .orderBy(desc(leadOutreachDraftsTable.createdAt))
      .limit(limit)
      .offset(offset);

    const ctxMap = await buildLeadContextMap(rows, ownerId);

    res.json(
      ListOutreachDraftsResponse.parse({
        drafts: rows.map((d) => serializeOutreachDraft(d, ctxMap.get(d.id))),
        total,
        limit,
        offset,
      }),
    );
  },
);

// ─── GET /leads/:leadId/outreach ──────────────────────────────────────────────

outreachRouter.get(
  "/leads/:leadId/outreach",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = GetLeadOutreachParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
      .limit(1);
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    const [optOut] = await db
      .select({ id: leadOutreachOptOutsTable.id })
      .from(leadOutreachOptOutsTable)
      .where(and(eq(leadOutreachOptOutsTable.ownerId, ownerId), eq(leadOutreachOptOutsTable.leadId, leadId)))
      .limit(1);
    const optedOut = Boolean(optOut);

    const drafts = await db
      .select()
      .from(leadOutreachDraftsTable)
      .where(and(eq(leadOutreachDraftsTable.ownerId, ownerId), eq(leadOutreachDraftsTable.leadId, leadId)))
      .orderBy(desc(leadOutreachDraftsTable.createdAt));

    const history = await db
      .select()
      .from(leadOutreachEventsTable)
      .where(and(eq(leadOutreachEventsTable.ownerId, ownerId), eq(leadOutreachEventsTable.leadId, leadId)))
      .orderBy(desc(leadOutreachEventsTable.occurredAt))
      .limit(100);

    // Opt-out takes priority over generic suppression wording.
    const blockedReason = optedOut
      ? "Lead has opted out of outreach — outreach is not allowed."
      : lead.suppressed
        ? "Lead is suppressed (Do Not Contact) — outreach is not allowed."
        : null;

    res.json(
      GetLeadOutreachResponse.parse({
        leadId,
        optedOut,
        suppressed: lead.suppressed,
        blockedReason,
        drafts: drafts.map((d) => serializeOutreachDraft(d, buildLeadContext(lead, d.channel))),
        history: history.map(serializeEvent),
      }),
    );
  },
);

// ─── POST /leads/:leadId/outreach ─────────────────────────────────────────────

outreachRouter.post(
  "/leads/:leadId/outreach",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = CreateOutreachDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = CreateOutreachDraftBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const channel = (body.data.channel ?? "email") as "email" | "whatsapp";
    const selectedFields = normalizeSelectedFields(body.data.selectedFields);
    const confirmImportedFields = normalizeSelectedFields(
      (body.data.confirmImportedFields ?? []).filter(isAllowedOutreachField),
    );

    if (selectedFields.length === 0) {
      res.status(400).json({ error: "selectedFields must include at least one allowlisted field." });
      return;
    }

    type TxResult =
      | { kind: "not_found" }
      | { kind: "blocked"; reason: string }
      | { kind: "not_qualified"; status: string }
      | { kind: "render_error"; reason: string }
      | { kind: "ok"; draft: LeadOutreachDraft; lead: Lead };

    // Serialize with every other mutation for this lead (incl. an in-flight
    // Gmail draft creation) via the single per-lead advisory lock.
    const result = await withOutreachLeadLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
      if (!lead) return { kind: "not_found" };

      const block = await findOutreachBlock(tx, ownerId, lead);
      if (block) return { kind: "blocked", reason: block };

      if (lead.pipelineStatus !== "qualified") {
        return { kind: "not_qualified", status: lead.pipelineStatus };
      }

      // Owner confirmation of imported facts (verified source written from the
      // CURRENT stored value, never client input) via the SINGLE shared helper
      // the tests exercise directly. This upgrades imported-only fields (e.g.
      // businessName) to approved provenance so loadApprovedFacts includes them.
      await confirmImportedFactSources(tx, {
        ownerId,
        lead,
        selectedFields,
        confirmImportedFields,
      });

      const facts = await loadApprovedFacts(tx, ownerId, lead);

      const rendered = renderFirstContactDraft({ selectedFields: selectedFields as OutreachField[], facts });
      if (!rendered.ok) {
        const reason =
          rendered.reason === "missing_business_name"
            ? "businessName is required and must be provenance-approved (user_provided or verified). Confirm imported fields if needed."
            : "No usable provenance-approved facts for the selected fields. Confirm imported fields if needed.";
        return { kind: "render_error", reason };
      }

      const draftId = newId();
      const operationKey = `siteforge-outreach-${draftId}`;
      const [draft] = await tx
        .insert(leadOutreachDraftsTable)
        .values({
          id: draftId, ownerId, leadId: lead.id, channel,
          status: "draft", gmailState: "none",
          subject: rendered.subject, body: rendered.body,
          factSnapshot: rendered.factSnapshot as unknown as Record<string, unknown>[],
          gmailOperationKey: operationKey,
        })
        .returning();

      await appendOutreachEvent(
        { ownerId, leadId: lead.id, draftId, eventType: "created",
          detail: { channel, fields: rendered.factSnapshot.map((f) => f.fieldName) },
          performedBy: ownerId },
        tx,
      );

      return { kind: "ok", draft: draft!, lead };
      }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release outreach create lock"),
    );

    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Lead not found." });
        return;
      case "blocked":
        res.status(409).json({ error: result.reason });
        return;
      case "not_qualified":
        res.status(400).json({ error: `Lead must be in 'qualified' status to create outreach (currently '${result.status}').` });
        return;
      case "render_error":
        res.status(400).json({ error: result.reason });
        return;
      case "ok":
        res.status(201).json(
          CreateOutreachDraftResponse.parse(
            serializeOutreachDraft(result.draft, buildLeadContext(result.lead, result.draft.channel)),
          ),
        );
        return;
    }
  },
);

// ─── PATCH /leads/:leadId/outreach/:draftId ───────────────────────────────────

outreachRouter.patch(
  "/leads/:leadId/outreach/:draftId",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = UpdateOutreachDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId, draftId } = params.data;

    const body = UpdateOutreachDraftBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    type TxResult =
      | { kind: "not_found" }
      | { kind: "blocked"; reason: string }
      | { kind: "not_editable" }
      | { kind: "ok"; draft: LeadOutreachDraft; lead: Lead };

    // Serialize with every other mutation for this lead (incl. an in-flight
    // Gmail draft creation) via the single per-lead advisory lock.
    const result = await withOutreachLeadLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
      if (!lead) return { kind: "not_found" };

      const draft = await loadDraftForUpdateTx(tx, ownerId, draftId);
      if (!draft || draft.leadId !== leadId) return { kind: "not_found" };

      const block = await findOutreachBlock(tx, ownerId, lead);
      if (block) return { kind: "blocked", reason: block };

      // Fail-closed: only a draft/reviewed row that is NOT mid-Gmail
      // (gmailState must be "none") may be edited. Under the shared lock a
      // Gmail attempt can never be concurrent, but this also refuses editing a
      // draft whose Gmail draft was already created (gmailState="created").
      if (
        (draft.status !== "draft" && draft.status !== "reviewed") ||
        draft.gmailState !== "none"
      ) {
        return { kind: "not_editable" };
      }

      const [updated] = await tx
        .update(leadOutreachDraftsTable)
        .set({ subject: body.data.subject ?? null, body: body.data.body, status: "draft", reviewedAt: null, updatedAt: new Date() })
        .where(and(
          eq(leadOutreachDraftsTable.id, draftId),
          eq(leadOutreachDraftsTable.ownerId, ownerId),
          eq(leadOutreachDraftsTable.gmailState, "none"),
        ))
        .returning();
      if (!updated) return { kind: "not_editable" };

      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "edited", detail: { clearedReview: true }, performedBy: ownerId },
        tx,
      );

      return { kind: "ok", draft: updated, lead };
      }),
      (error) => req.log.error({ error: String(error), leadId, draftId }, "Failed to release outreach edit lock"),
    );

    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Outreach draft not found." });
        return;
      case "blocked":
        res.status(409).json({ error: result.reason });
        return;
      case "not_editable":
        res.status(409).json({ error: "This outreach draft can no longer be edited." });
        return;
      case "ok":
        res.json(
          UpdateOutreachDraftResponse.parse(
            serializeOutreachDraft(result.draft, buildLeadContext(result.lead, result.draft.channel)),
          ),
        );
        return;
    }
  },
);

// ─── POST /leads/:leadId/outreach/:draftId/review ─────────────────────────────

outreachRouter.post(
  "/leads/:leadId/outreach/:draftId/review",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = ReviewOutreachDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId, draftId } = params.data;

    type TxResult =
      | { kind: "not_found" }
      | { kind: "blocked"; reason: string }
      | { kind: "not_reviewable" }
      | { kind: "ok"; draft: LeadOutreachDraft; lead: Lead };

    // Serialize with every other mutation for this lead via the per-lead lock.
    const result = await withOutreachLeadLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
      if (!lead) return { kind: "not_found" };

      const draft = await loadDraftForUpdateTx(tx, ownerId, draftId);
      if (!draft || draft.leadId !== leadId) return { kind: "not_found" };

      const block = await findOutreachBlock(tx, ownerId, lead);
      if (block) return { kind: "blocked", reason: block };

      // Fail-closed: only a "draft" row with gmailState="none" may be reviewed.
      if (draft.status !== "draft" || draft.gmailState !== "none") {
        return { kind: "not_reviewable" };
      }

      const [updated] = await tx
        .update(leadOutreachDraftsTable)
        .set({ status: "reviewed", reviewedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(leadOutreachDraftsTable.id, draftId),
          eq(leadOutreachDraftsTable.ownerId, ownerId),
          eq(leadOutreachDraftsTable.status, "draft"),
          eq(leadOutreachDraftsTable.gmailState, "none"),
        ))
        .returning();
      if (!updated) return { kind: "not_reviewable" };

      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "reviewed", performedBy: ownerId },
        tx,
      );

      return { kind: "ok", draft: updated, lead };
      }),
      (error) => req.log.error({ error: String(error), leadId, draftId }, "Failed to release outreach review lock"),
    );

    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Outreach draft not found." });
        return;
      case "blocked":
        res.status(409).json({ error: result.reason });
        return;
      case "not_reviewable":
        res.status(409).json({ error: "Only an unreviewed draft can be marked reviewed." });
        return;
      case "ok":
        res.json(
          ReviewOutreachDraftResponse.parse(
            serializeOutreachDraft(result.draft, buildLeadContext(result.lead, result.draft.channel)),
          ),
        );
        return;
    }
  },
);

// ─── POST /leads/:leadId/outreach/:draftId/gmail-draft ────────────────────────
//
// FAIL-CLOSED, RECONCILIATION-SAFE Gmail draft creation. Held entirely under the
// single per-lead advisory lock (shared with every other outreach mutation), so
// no edit/review/discard/reply/opt-out can interleave.
//
// State machine (gmailState on the draft row):
//
//   none      → fresh attempt. Recheck eligibility + headers, claim
//               reviewed→requesting recording gmail_attempt_started_at, then
//               issue EXACTLY ONE provider POST:
//                 created   → gmailState=created (200)
//                 ambiguous → STAY requesting, audit gmail_reconciliation_pending,
//                             return 502 pending. NEVER reset to none. NEVER POST
//                             again on a later call.
//                 rejected  → definitive validation rejection with no landed POST
//                             possible → gmailState=failed, audit gmail_failed,
//                             409. (Header validation is also done pre-claim, so
//                             this is belt-and-suspenders.)
//
//   requesting → an earlier attempt is unconfirmed. LOOKUP ONLY by the stable
//                operationKey; NEVER POST:
//                 found                        → gmailState=created, audit
//                                                gmail_reconciled, 200.
//                 unavailable                  → STAY requesting, audit
//                                                gmail_reconciliation_pending, 409.
//                 not_found & < 2 min elapsed  → STAY requesting, audit
//                                                gmail_reconciliation_pending, 409.
//                 not_found & ≥ 2 min elapsed  → reviewed + gmailState=none,
//                                                audit gmail_retry_ready, 409. A
//                                                SEPARATE later owner POST may
//                                                then create fresh.
//                Reconciliation records the real outcome even if the lead was
//                opted out AFTER the original attempt — it never POSTs.
//
//   created    → idempotent 200.
//
// A process crash after claim/POST leaves gmailState=requesting; the next call
// recovers via the requesting branch (lookup-only). There is no auto-expiry and
// no blind re-POST.

outreachRouter.post(
  "/leads/:leadId/outreach/:draftId/gmail-draft",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = CreateOutreachGmailDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId, draftId } = params.data;

    type HandlerResult =
      | { http: number; error: string }
      | { http: 200; payload: ReturnType<typeof CreateOutreachGmailDraftResponse.parse> };

    const outcome = await withOutreachLeadLock(
      ownerId,
      leadId,
      async (lockedDb): Promise<HandlerResult> => {
        // ── Phase 1: classify the row under a FOR UPDATE transaction. ──────────
        // We decide which branch to run WITHOUT any provider call yet. The only
        // mutation here is the fresh-attempt claim (reviewed+none → requesting).
        type Prep =
          | { kind: "not_found" }
          | { kind: "blocked"; reason: string }
          | { kind: "provider_disabled" }
          | { kind: "invalid_header"; reason: string }
          | { kind: "whatsapp"; lead: Lead; draft: LeadOutreachDraft }
          | { kind: "already_created"; lead: Lead; draft: LeadOutreachDraft }
          | { kind: "reconcile"; lead: Lead; draft: LeadOutreachDraft; operationKey: string }
          | { kind: "not_reviewed" }
          | { kind: "no_recipient" }
          | { kind: "claimed"; lead: Lead; draft: LeadOutreachDraft; operationKey: string; recipientEmail: string };

        const prep = await lockedDb.transaction(async (tx): Promise<Prep> => {
          const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
          if (!lead) return { kind: "not_found" };

          const draft = await loadDraftForUpdateTx(tx, ownerId, draftId);
          if (!draft || draft.leadId !== leadId) return { kind: "not_found" };

          // WhatsApp never sends — honest provider-not-configured state.
          if (draft.channel === "whatsapp") return { kind: "whatsapp", lead, draft };

          // Idempotent success: a draft was already confirmed created.
          if (draft.status === "gmail_draft_created" || draft.gmailState === "created") {
            return { kind: "already_created", lead, draft };
          }

          const operationKey = draft.gmailOperationKey ?? `siteforge-outreach-${draft.id}`;

          // RECONCILE branch: a prior attempt is unconfirmed. We do NOT block on
          // opt-out here — reconciliation must be able to record the real
          // outcome of an attempt that already POSTed, even if the lead opted
          // out afterwards. It is lookup-only and never POSTs.
          if (draft.gmailState === "requesting") {
            return { kind: "reconcile", lead, draft, operationKey };
          }

          const [emailProviderSetting] = await tx
            .select({ enabled: providerSettingsTable.enabled })
            .from(providerSettingsTable)
            .where(
              and(
                eq(providerSettingsTable.ownerId, ownerId),
                eq(providerSettingsTable.capability, "email"),
              ),
            )
            .limit(1);
          if (emailProviderSetting?.enabled === false) {
            return { kind: "provider_disabled" };
          }

          // Fresh attempt: gmailState must be none (or the definitive "failed").
          // Eligibility (incl. opt-out) is rechecked before a NEW POST.
          const block = await findOutreachBlock(tx, ownerId, lead);
          if (block) return { kind: "blocked", reason: block };

          if (draft.status !== "reviewed" || draft.reviewedAt == null) {
            return { kind: "not_reviewed" };
          }

          const recipientEmail = lead.email;
          if (!recipientEmail || recipientEmail.trim() === "") {
            return { kind: "no_recipient" };
          }

          // Header safety BEFORE claiming, so a rejection never leaves a
          // half-claimed record.
          const recipientErr = validateOutreachEmailRecipient(recipientEmail.trim());
          if (recipientErr) return { kind: "invalid_header", reason: recipientErr };

          const subjectErr = validateOutreachSubject(draft.subject ?? "A quick note");
          if (subjectErr) return { kind: "invalid_header", reason: subjectErr };

          // Conditional claim: reviewed + (none|failed) → requesting, stamping a
          // durable attempt-start time for the reconciliation delay.
          const attemptStartedAt = new Date();
          const [claimed] = await tx
            .update(leadOutreachDraftsTable)
            .set({
              gmailState: "requesting",
              gmailOperationKey: operationKey,
              gmailAttemptStartedAt: attemptStartedAt,
              failureReason: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(leadOutreachDraftsTable.id, draftId),
              eq(leadOutreachDraftsTable.ownerId, ownerId),
              eq(leadOutreachDraftsTable.status, "reviewed"),
              inArray(leadOutreachDraftsTable.gmailState, ["none", "failed"]),
            ))
            .returning();
          if (!claimed) return { kind: "not_reviewed" };

          await appendOutreachEvent(
            { ownerId, leadId, draftId, eventType: "gmail_requested", detail: { operationKey }, performedBy: ownerId },
            tx,
          );

          return { kind: "claimed", lead, draft: claimed, operationKey, recipientEmail: recipientEmail.trim() };
        });

        switch (prep.kind) {
          case "not_found":
            return { http: 404, error: "Outreach draft not found." };
          case "blocked":
            return { http: 409, error: prep.reason };
          case "provider_disabled":
            return {
              http: 409,
              error:
                "Gmail draft creation is disabled in provider settings.",
            };
          case "invalid_header":
            return { http: 409, error: prep.reason };
          case "not_reviewed":
            return { http: 409, error: "The current copy must be reviewed before creating a Gmail draft." };
          case "no_recipient":
            return { http: 409, error: "This lead has no email address on file, so a Gmail draft cannot be created." };
          case "whatsapp": {
            const w = whatsappNotConfiguredState();
            return {
              http: 200,
              payload: CreateOutreachGmailDraftResponse.parse({
                draftId: prep.draft.id, channel: "whatsapp",
                status: "provider_not_configured", gmailDraftId: null,
                message: w.message,
                draft: serializeOutreachDraft(prep.draft, buildLeadContext(prep.lead, prep.draft.channel)),
              }),
            };
          }
          case "already_created":
            return {
              http: 200,
              payload: CreateOutreachGmailDraftResponse.parse({
                draftId: prep.draft.id, channel: "email",
                status: "gmail_draft_created",
                gmailDraftId: prep.draft.gmailDraftId ?? null,
                message: null,
                draft: serializeOutreachDraft(prep.draft, buildLeadContext(prep.lead, prep.draft.channel)),
              }),
            };
          case "reconcile":
            return reconcileRequestingDraft(lockedDb, {
              ownerId, leadId, draftId,
              lead: prep.lead, draft: prep.draft, operationKey: prep.operationKey,
              performedBy: ownerId, logError: (e) => req.log.error({ error: String(e), draftId }, "Outreach reconcile lookup failed"),
            });
          case "claimed":
            break;
        }

        // ── Phase 1b: DEFENSE-IN-DEPTH PREFLIGHT, immediately before the POST,
        // still holding the shared per-lead lock. The lock already makes a
        // concurrent DNC/recipient/eligibility change impossible, but we re-read
        // the owner-scoped lead + durable block state through the SAME locked
        // connection and re-verify the recipient email, block state, and that
        // THIS draft still owns the reviewed→requesting claim. If anything
        // changed or the lead is now blocked, we FAIL CLOSED with NO provider
        // POST and release the claim so a later attempt can re-check.
        const preflight = await lockedDb.transaction(async (tx) => {
          const freshLead = await loadLeadForUpdateTx(tx, ownerId, leadId);
          if (!freshLead) return { ok: false as const, http: 404, error: "Outreach draft not found." };

          const block = await findOutreachBlock(tx, ownerId, freshLead);
          if (block) return { ok: false as const, http: 409, error: block };

          const freshEmail = (freshLead.email ?? "").trim();
          if (!freshEmail) {
            return { ok: false as const, http: 409, error: "This lead has no email address on file, so a Gmail draft cannot be created." };
          }
          if (freshEmail !== prep.recipientEmail) {
            return { ok: false as const, http: 409, error: "The lead's email changed while preparing the Gmail draft. Please review the draft again." };
          }

          const freshDraft = await loadDraftForUpdateTx(tx, ownerId, draftId);
          if (!freshDraft || freshDraft.leadId !== leadId) {
            return { ok: false as const, http: 404, error: "Outreach draft not found." };
          }
          // The claim from Phase 1 must still be intact: this draft must still be
          // the one in gmailState=requesting with our operation key.
          if (freshDraft.gmailState !== "requesting" || freshDraft.gmailOperationKey !== prep.operationKey) {
            return { ok: false as const, http: 409, error: "This draft is no longer ready to send. Please review the draft again." };
          }
          const [emailProviderSetting] = await tx
            .select({ enabled: providerSettingsTable.enabled })
            .from(providerSettingsTable)
            .where(
              and(
                eq(providerSettingsTable.ownerId, ownerId),
                eq(providerSettingsTable.capability, "email"),
              ),
            )
            .limit(1);
          if (emailProviderSetting?.enabled === false) {
            return {
              ok: false as const,
              http: 409,
              error:
                "Gmail draft creation is disabled in provider settings.",
            };
          }
          return { ok: true as const };
        });

        if (!preflight.ok) {
          // Release the claim we took in Phase 1 so the row is not stranded in
          // `requesting`. We only clear a claim that is still ours and never
          // POSTed (safe: no ambiguous provider state exists yet).
          await lockedDb.transaction(async (tx) => {
            await tx
              .update(leadOutreachDraftsTable)
              .set({ gmailState: "none", gmailAttemptStartedAt: null, updatedAt: new Date() })
              .where(and(
                eq(leadOutreachDraftsTable.id, draftId),
                eq(leadOutreachDraftsTable.ownerId, ownerId),
                eq(leadOutreachDraftsTable.gmailState, "requesting"),
                eq(leadOutreachDraftsTable.gmailOperationKey, prep.operationKey),
              ));
            await appendOutreachEvent(
              { ownerId, leadId, draftId, eventType: "gmail_retry_ready", detail: { reason: "preflight_changed", phase: "pre_post" }, performedBy: ownerId },
              tx,
            );
          });
          return { http: preflight.http, error: preflight.error };
        }

        // ── Phase 2: fresh attempt — EXACTLY ONE provider POST, under the lock.
        const connector = new ReplitConnectors() as unknown as OutreachGmailConnector;
        const gmailOutcome = await createOutreachGmailDraft(connector, {
          operationKey: prep.operationKey,
          recipientEmail: prep.recipientEmail,
          subject: prep.draft.subject ?? "A quick note",
          body: prep.draft.body,
        });

        // ── Phase 3: persist the honest outcome. ───────────────────────────────
        if (gmailOutcome.kind === "created") {
          const [updated] = await lockedDb.transaction(async (tx) => {
            const rows = await tx
              .update(leadOutreachDraftsTable)
              .set({
                status: "gmail_draft_created", gmailState: "created",
                gmailDraftId: gmailOutcome.gmailDraftId,
                gmailMessageId: gmailOutcome.gmailMessageId,
                gmailDraftCreatedAt: new Date(),
                gmailAttemptStartedAt: null,
                failureReason: null, updatedAt: new Date(),
              })
              .where(and(
                eq(leadOutreachDraftsTable.id, draftId),
                eq(leadOutreachDraftsTable.ownerId, ownerId),
                eq(leadOutreachDraftsTable.gmailState, "requesting"),
              ))
              .returning();
            await appendOutreachEvent(
              { ownerId, leadId, draftId, eventType: "gmail_created", detail: { gmailDraftId: gmailOutcome.gmailDraftId }, performedBy: ownerId },
              tx,
            );
            return rows;
          });
          const draftRow = updated ?? prep.draft;
          return {
            http: 200,
            payload: CreateOutreachGmailDraftResponse.parse({
              draftId, channel: "email", status: "gmail_draft_created",
              gmailDraftId: gmailOutcome.gmailDraftId, message: null,
              draft: serializeOutreachDraft(draftRow, buildLeadContext(prep.lead, "email")),
            }),
          };
        }

        if (gmailOutcome.kind === "rejected") {
          // Definitive rejection: NO draft could have landed. Mark failed so the
          // row is retryable (a later corrected attempt re-claims from failed).
          await lockedDb.transaction(async (tx) => {
            await tx
              .update(leadOutreachDraftsTable)
              .set({ status: "reviewed", gmailState: "failed", gmailAttemptStartedAt: null, failureReason: gmailOutcome.error, updatedAt: new Date() })
              .where(and(
                eq(leadOutreachDraftsTable.id, draftId),
                eq(leadOutreachDraftsTable.ownerId, ownerId),
                eq(leadOutreachDraftsTable.gmailState, "requesting"),
              ));
            await appendOutreachEvent(
              { ownerId, leadId, draftId, eventType: "gmail_failed", detail: { reason: gmailOutcome.reason }, performedBy: ownerId },
              tx,
            );
          });
          return { http: gmailOutcome.status, error: gmailOutcome.error };
        }

        // AMBIGUOUS: the POST may have landed. STAY requesting (fail closed).
        // Do NOT reset to none; a later call reconciles lookup-only.
        await lockedDb.transaction(async (tx) => {
          await tx
            .update(leadOutreachDraftsTable)
            .set({ failureReason: gmailOutcome.error, updatedAt: new Date() })
            .where(and(
              eq(leadOutreachDraftsTable.id, draftId),
              eq(leadOutreachDraftsTable.ownerId, ownerId),
              eq(leadOutreachDraftsTable.gmailState, "requesting"),
            ));
          await appendOutreachEvent(
            { ownerId, leadId, draftId, eventType: "gmail_reconciliation_pending", detail: { reason: gmailOutcome.reason, phase: "post_attempt" }, performedBy: ownerId },
            tx,
          );
        });
        return { http: gmailOutcome.status, error: gmailOutcome.error };
      },
      (error) => req.log.error({ error: String(error), draftId }, "Failed to release outreach Gmail lock"),
    );

    if ("payload" in outcome) {
      res.json(outcome.payload);
      return;
    }
    res.status(outcome.http).json({ error: outcome.error });
  },
);

/**
 * Lookup-ONLY reconciliation of a row already in gmailState=requesting.
 *
 * Issues a single Gmail search by the stable operationKey and NEVER POSTs.
 * Runs entirely under the caller's per-lead lock and uses the scoped lockedDb.
 *
 *   found                        → created (200)
 *   unavailable                  → stay requesting, pending (409)
 *   not_found & < delay elapsed  → stay requesting, pending (409)
 *   not_found & ≥ delay elapsed  → reviewed+none, retry-ready (409)
 *
 * The 2-minute delay is measured from the durable gmailAttemptStartedAt so it
 * survives process death. If that timestamp is missing (legacy row), we treat
 * the delay as NOT elapsed — fail closed — until a real attempt records one.
 */
async function reconcileRequestingDraft(
  lockedDb: LockedDb,
  ctx: {
    ownerId: string;
    leadId: string;
    draftId: string;
    lead: Lead;
    draft: LeadOutreachDraft;
    operationKey: string;
    performedBy: string;
    // eslint-disable-next-line no-unused-vars
    logError: (error: unknown) => void;
  },
): Promise<
  | { http: number; error: string }
  | { http: 200; payload: ReturnType<typeof CreateOutreachGmailDraftResponse.parse> }
> {
  const { ownerId, leadId, draftId, lead, draft, operationKey, performedBy } = ctx;

  const connector = new ReplitConnectors() as unknown as OutreachGmailConnector;
  const lookup = await reconcileOutreachGmailDraft(connector, operationKey);

  if (lookup.kind === "found") {
    // The earlier attempt DID create a draft — record it honestly.
    const [updated] = await lockedDb.transaction(async (tx) => {
      const rows = await tx
        .update(leadOutreachDraftsTable)
        .set({
          status: "gmail_draft_created", gmailState: "created",
          gmailMessageId: lookup.gmailMessageId,
          gmailDraftCreatedAt: new Date(),
          gmailAttemptStartedAt: null,
          failureReason: null, updatedAt: new Date(),
        })
        .where(and(
          eq(leadOutreachDraftsTable.id, draftId),
          eq(leadOutreachDraftsTable.ownerId, ownerId),
          eq(leadOutreachDraftsTable.gmailState, "requesting"),
        ))
        .returning();
      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "gmail_reconciled", detail: { gmailMessageId: lookup.gmailMessageId }, performedBy },
        tx,
      );
      return rows;
    });
    const draftRow = updated ?? draft;
    return {
      http: 200,
      payload: CreateOutreachGmailDraftResponse.parse({
        draftId, channel: "email", status: "gmail_draft_created",
        gmailDraftId: draftRow.gmailDraftId ?? null, message: null,
        draft: serializeOutreachDraft(draftRow, buildLeadContext(lead, "email")),
      }),
    };
  }

  if (lookup.kind === "unavailable") {
    // Cannot confirm either way — remain requesting, honest pending.
    await lockedDb.transaction(async (tx) => {
      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "gmail_reconciliation_pending", detail: { reason: "lookup_unavailable" }, performedBy },
        tx,
      );
    });
    return {
      http: 409,
      error: "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  // not_found — only conclude "no draft" after the safety delay has elapsed,
  // measured from the durable attempt-start timestamp.
  const startedAtMs = draft.gmailAttemptStartedAt
    ? new Date(draft.gmailAttemptStartedAt).getTime()
    : Number.NaN;
  const elapsed =
    Number.isFinite(startedAtMs) &&
    Date.now() - startedAtMs >= OUTREACH_RECONCILIATION_DELAY_MS;

  if (!elapsed) {
    await lockedDb.transaction(async (tx) => {
      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "gmail_reconciliation_pending", detail: { reason: "not_found_within_delay" }, performedBy },
        tx,
      );
    });
    return {
      http: 409,
      error: "The earlier Gmail draft attempt is still being reconciled. Try again shortly.",
    };
  }

  // Confirmed not found after the delay: safe to declare no draft exists and
  // make a fresh attempt possible. Transition requesting → reviewed+none.
  await lockedDb.transaction(async (tx) => {
    await tx
      .update(leadOutreachDraftsTable)
      .set({
        status: "reviewed", gmailState: "none",
        gmailAttemptStartedAt: null,
        failureReason: "No Gmail draft was found for the earlier attempt.",
        updatedAt: new Date(),
      })
      .where(and(
        eq(leadOutreachDraftsTable.id, draftId),
        eq(leadOutreachDraftsTable.ownerId, ownerId),
        eq(leadOutreachDraftsTable.gmailState, "requesting"),
      ));
    await appendOutreachEvent(
      { ownerId, leadId, draftId, eventType: "gmail_retry_ready", detail: { reconciliationResult: "not_found" }, performedBy },
      tx,
    );
  });
  return {
    http: 409,
    error:
      "No Gmail draft was found for the earlier attempt. A fresh creation attempt is now ready — submit again to create one.",
  };
}

// ─── POST /leads/:leadId/outreach/:draftId/discard ────────────────────────────

outreachRouter.post(
  "/leads/:leadId/outreach/:draftId/discard",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = DiscardOutreachDraftParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId, draftId } = params.data;

    type TxResult =
      | { kind: "not_found" }
      | { kind: "blocked"; reason: string }
      | { kind: "terminal" }
      | { kind: "gmail_in_flight" }
      | { kind: "ok"; draft: LeadOutreachDraft; lead: Lead };

    // Serialize with every other mutation for this lead via the per-lead lock.
    const result = await withOutreachLeadLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      // Reload lead FOR UPDATE and check DNC/opt-out before acting.
      const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
      if (!lead) return { kind: "not_found" };

      const draft = await loadDraftForUpdateTx(tx, ownerId, draftId);
      if (!draft || draft.leadId !== leadId) return { kind: "not_found" };

      const block = await findOutreachBlock(tx, ownerId, lead);
      if (block) return { kind: "blocked", reason: block };

      if (draft.status === "discarded") return { kind: "terminal" };

      // Fail-closed: never discard while a Gmail draft creation is in flight.
      // (Cannot happen under the shared lock, but rejected defensively so a
      // stuck "requesting" row is never silently discarded mid-provider-call.)
      if (draft.gmailState === "requesting") return { kind: "gmail_in_flight" };

      const [updated] = await tx
        .update(leadOutreachDraftsTable)
        .set({ status: "discarded", discardedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(leadOutreachDraftsTable.id, draftId),
          eq(leadOutreachDraftsTable.ownerId, ownerId),
        ))
        .returning();

      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "discarded", performedBy: ownerId },
        tx,
      );

      return { kind: "ok", draft: updated!, lead };
      }),
      (error) => req.log.error({ error: String(error), leadId, draftId }, "Failed to release outreach discard lock"),
    );

    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Outreach draft not found." });
        return;
      case "blocked":
        res.status(409).json({ error: result.reason });
        return;
      case "terminal":
        res.status(409).json({ error: "This outreach draft is already discarded." });
        return;
      case "gmail_in_flight":
        res.status(409).json({ error: "A Gmail draft is currently being created for this outreach; try again shortly." });
        return;
      case "ok":
        res.json(
          DiscardOutreachDraftResponse.parse(
            serializeOutreachDraft(result.draft, buildLeadContext(result.lead, result.draft.channel)),
          ),
        );
        return;
    }
  },
);

// ─── POST /leads/:leadId/outreach/:draftId/reply ──────────────────────────────

outreachRouter.post(
  "/leads/:leadId/outreach/:draftId/reply",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = MarkOutreachReplyParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId, draftId } = params.data;

    type TxResult =
      | { kind: "not_found" }
      | { kind: "blocked"; reason: string }
      | { kind: "gmail_in_flight" }
      | { kind: "ok"; draft: LeadOutreachDraft; lead: Lead };

    // Serialize with every other mutation for this lead via the per-lead lock.
    const result = await withOutreachLeadLock(
      ownerId,
      leadId,
      (lockedDb) => lockedDb.transaction(async (tx): Promise<TxResult> => {
      // Reload lead FOR UPDATE and check DNC/opt-out before acting.
      const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
      if (!lead) return { kind: "not_found" };

      const draft = await loadDraftForUpdateTx(tx, ownerId, draftId);
      if (!draft || draft.leadId !== leadId) return { kind: "not_found" };

      const block = await findOutreachBlock(tx, ownerId, lead);
      if (block) return { kind: "blocked", reason: block };

      // Fail-closed: never record a reply while a Gmail draft creation is in
      // flight — that would order the history event before the gmail outcome.
      if (draft.gmailState === "requesting") return { kind: "gmail_in_flight" };

      // A reply is a real, human-observed action — recorded honestly. We only
      // set repliedAt/status; we never invent delivery events.
      const [updated] = await tx
        .update(leadOutreachDraftsTable)
        .set({ status: "replied", repliedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(leadOutreachDraftsTable.id, draftId), eq(leadOutreachDraftsTable.ownerId, ownerId)))
        .returning();

      await appendOutreachEvent(
        { ownerId, leadId, draftId, eventType: "reply_marked", performedBy: ownerId },
        tx,
      );

      return { kind: "ok", draft: updated!, lead };
      }),
      (error) => req.log.error({ error: String(error), leadId, draftId }, "Failed to release outreach reply lock"),
    );

    switch (result.kind) {
      case "not_found":
        res.status(404).json({ error: "Outreach draft not found." });
        return;
      case "blocked":
        res.status(409).json({ error: result.reason });
        return;
      case "gmail_in_flight":
        res.status(409).json({ error: "A Gmail draft is currently being created for this outreach; try again shortly." });
        return;
      case "ok":
        res.json(
          MarkOutreachReplyResponse.parse(
            serializeOutreachDraft(result.draft, buildLeadContext(result.lead, result.draft.channel)),
          ),
        );
        return;
    }
  },
);

// ─── POST /leads/:leadId/outreach/opt-out ─────────────────────────────────────
//
// The opt-out handler acquires the SAME per-lead advisory lock as every other
// outreach mutation, so an in-flight Gmail creation (or any edit/review/
// discard/reply) and a concurrent opt-out are serialized. Opt-out commits the
// suppression under the lock; any Gmail attempt that starts after that sees the
// opt-out row and rejects.
//
// The opt-out action itself is NOT blocked by existing suppression.

outreachRouter.post(
  "/leads/:leadId/outreach/opt-out",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;
    const params = OptOutLeadOutreachParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = OptOutLeadOutreachBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const reason = body.data.reason ?? null;
    const channel = body.data.channel ?? null;

    // Per-lead advisory lock (the single shared outreach key) — serializes with
    // every other outreach mutation for this lead. Opt-out acquires the lock
    // then commits; a later Gmail attempt reloads the opt-out row inside its
    // transaction under the same lock and rejects.
    type LockResult =
      | { kind: "not_found" }
      | { kind: "ok"; lead: Lead };

    const lockResult = await withOutreachLeadLock(
      ownerId,
      leadId,
      async (lockedDb): Promise<LockResult> => {
        const result = await lockedDb.transaction(async (tx) => {
          const lead = await loadLeadForUpdateTx(tx, ownerId, leadId);
          if (!lead) return { kind: "not_found" as const };

          // Canonical opt-out propagation (opt-out row + suppression record +
          // leads.suppressed=true + timeline) via the SINGLE shared helper the
          // tests exercise directly.
          const { lead: updatedLead } = await applyOutreachOptOut(tx, {
            ownerId,
            leadId,
            reason,
            channel,
            performedBy: ownerId,
          });

          // Append honest outreach opt-out audit events per draft.
          const drafts = await tx
            .select({ id: leadOutreachDraftsTable.id })
            .from(leadOutreachDraftsTable)
            .where(and(eq(leadOutreachDraftsTable.ownerId, ownerId), eq(leadOutreachDraftsTable.leadId, leadId)));

          for (const d of drafts as Array<{ id: string }>) {
            await appendOutreachEvent(
              { ownerId, leadId, draftId: d.id, eventType: "opted_out", detail: { reason, channel }, performedBy: ownerId },
              tx,
            );
          }

          return { kind: "ok" as const, lead: updatedLead ?? lead };
        });
        return result;
      },
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release outreach opt-out lock"),
    );

    if (lockResult.kind === "not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }

    // Rebuild summary after opt-out committed.
    const drafts = await db
      .select()
      .from(leadOutreachDraftsTable)
      .where(and(eq(leadOutreachDraftsTable.ownerId, ownerId), eq(leadOutreachDraftsTable.leadId, leadId)))
      .orderBy(desc(leadOutreachDraftsTable.createdAt));

    const history = await db
      .select()
      .from(leadOutreachEventsTable)
      .where(and(eq(leadOutreachEventsTable.ownerId, ownerId), eq(leadOutreachEventsTable.leadId, leadId)))
      .orderBy(desc(leadOutreachEventsTable.occurredAt))
      .limit(100);

    res.json(
      OptOutLeadOutreachResponse.parse({
        leadId,
        optedOut: true,
        suppressed: lockResult.lead.suppressed,
        // Opt-out always takes priority: it is the user-intentional reason
        // even when suppressed=true (opt-out sets suppressed as a side effect).
        blockedReason: "Lead has opted out of outreach — outreach is not allowed.",
        drafts: drafts.map((d) =>
          serializeOutreachDraft(d, buildLeadContext(lockResult.lead, d.channel)),
        ),
        history: history.map(serializeEvent),
      }),
    );
  },
);
