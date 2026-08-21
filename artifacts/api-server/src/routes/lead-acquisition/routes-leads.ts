/**
 * Lead acquisition: core lead CRUD routes.
 *
 * GET    /leads
 * POST   /leads            — atomic: advisory lock → dup check → insert (single tx)
 * POST   /leads/import     — atomic: advisory lock → dup check → batch insert (single tx)
 * GET    /leads/:leadId
 * PATCH  /leads/:leadId    — atomic: advisory lock → dup check (if identifying fields change) → update (single tx)
 * POST   /leads/:leadId/score
 *
 * ## Atomicity and duplicate prevention
 *
 * Duplicate detection is a read-then-write operation that is vulnerable to
 * TOCTOU races under concurrent requests for the same owner.  All three paths
 * that can introduce duplicates use the same locking protocol:
 *
 *   1. Open a DB transaction.
 *   2. Acquire `pg_advisory_xact_lock` for the owner (via acquireOwnerDuplicateLock).
 *      Requests for the same owner serialize here; different owners are unaffected.
 *   3. Read existing leads for duplicate check inside the same transaction
 *      (fetchLeadsForDuplicateCheckTx) — this read is inside the lock boundary.
 *   4. Perform INSERT / UPDATE inside the same transaction.
 *   5. Transaction commits → lock is automatically released.
 *
 * Import acquires the lock once and processes the entire batch inside a single
 * transaction so the lock is held for the full batch, not per-item.
 *
 * The lock key is derived deterministically from the authenticated sfUserId
 * (set by requireAuth middleware, never from user-supplied body fields).
 */

import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  leadsTable,
  leadSourcesTable,
  leadScoresTable,
  leadActivitiesTable,
  leadSuppressionsTable,
} from "@workspace/db";
import {
  ListLeadsResponse,
  CreateLeadBody,
  CreateLeadResponse,
  ImportLeadsBody,
  ImportLeadsResponse,
  GetLeadParams,
  GetLeadResponse,
  UpdateLeadParams,
  UpdateLeadBody,
  UpdateLeadResponse,
  ScoreLeadNowParams,
  ScoreLeadNowResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { findDuplicate } from "../../lib/lead-normalization";
import { withLeadMutationLock } from "../../lib/lead-mutation-lock";
import {
  requireFeatureEnabled,
  serializeLead,
  buildScoreSummary,
  buildSuppressionSummary,
  SCORE_RELEVANT_FIELDS,
  DUPLICATE_IDENTIFYING_FIELDS,
  newId,
} from "./helpers";
import {
  acquireOwnerDuplicateLock,
  runAndPersistScore,
  fetchLeadsForDuplicateCheckTx,
  buildSourceRecords,
  appendActivity,
  recordLeadEditProvenance,
} from "./lead-ops";

export const leadsRouter: IRouter = Router();

// ─── GET /leads ────────────────────────────────────────────────────────────────

leadsRouter.get(
  "/leads",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const search =
      typeof req.query["search"] === "string" ? req.query["search"] : undefined;
    const pipelineStatus =
      typeof req.query["pipelineStatus"] === "string" ? req.query["pipelineStatus"] : undefined;
    const websiteStatus =
      typeof req.query["websiteStatus"] === "string" ? req.query["websiteStatus"] : undefined;
    const suppressedParam =
      typeof req.query["suppressed"] === "string" ? req.query["suppressed"] : undefined;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query["offset"] ?? "0"), 10) || 0);

    const conditions = [eq(leadsTable.ownerId, ownerId)];

    if (search) {
      conditions.push(
        or(
          ilike(leadsTable.businessName, `%${search}%`),
          ilike(leadsTable.city, `%${search}%`),
          ilike(leadsTable.category, `%${search}%`),
        )!,
      );
    }
    if (pipelineStatus) conditions.push(eq(leadsTable.pipelineStatus, pipelineStatus));
    if (websiteStatus) conditions.push(eq(leadsTable.websiteStatus, websiteStatus));
    if (suppressedParam === "true") conditions.push(eq(leadsTable.suppressed, true));
    else if (suppressedParam === "false") conditions.push(eq(leadsTable.suppressed, false));

    const where = and(...conditions)!;

    const [{ count: totalRaw }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(where);
    const total = Number(totalRaw ?? 0);

    const rows = await db
      .select()
      .from(leadsTable)
      .where(where)
      .orderBy(desc(leadsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json(ListLeadsResponse.parse({ leads: rows.map(serializeLead), total, limit, offset }));
  },
);

// ─── POST /leads ───────────────────────────────────────────────────────────────
//
// Advisory lock protocol:
//   tx start → acquireOwnerDuplicateLock → fetchLeadsForDuplicateCheckTx
//   → findDuplicate → insert lead → insert provenance → tx commit → lock released
//   Score persistence runs outside the tx (no duplicate-identifying writes).

leadsRouter.post(
  "/leads",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const body = CreateLeadBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const input = body.data;

    // Validate reviewCount up-front (cheap, avoids entering the tx unnecessarily)
    if (
      input.reviewCount !== undefined &&
      input.reviewCount !== null &&
      (!Number.isSafeInteger(input.reviewCount) || input.reviewCount < 0)
    ) {
      res.status(400).json({ error: "reviewCount must be a safe non-negative integer." });
      return;
    }

    const leadId = newId();

    // ── Atomic duplicate check + insert ────────────────────────────────────
    type TxResult =
      | { kind: "duplicate"; duplicateLeadId: string }
      | { kind: "ok"; lead: typeof leadsTable.$inferSelect };

    const txResult = await db.transaction(async (tx): Promise<TxResult> => {
      // Step 1: acquire owner-scoped advisory lock (blocks concurrent requests)
      await acquireOwnerDuplicateLock(tx, ownerId);

      // Step 2: read existing leads inside the lock boundary
      const existing = await fetchLeadsForDuplicateCheckTx(tx, ownerId);

      // Step 3: check for duplicate
      const duplicateLeadId = findDuplicate(
        {
          phone: input.phone ?? undefined,
          email: input.email ?? undefined,
          websiteUrl: input.websiteUrl ?? undefined,
          businessName: input.businessName,
          city: input.city ?? undefined,
        },
        existing,
      );
      if (duplicateLeadId) return { kind: "duplicate", duplicateLeadId };

      // Step 4: insert lead
      const [lead] = await tx
        .insert(leadsTable)
        .values({
          id: leadId,
          ownerId,
          businessName: input.businessName,
          category: input.category ?? null,
          description: input.description ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          region: input.region ?? null,
          postalCode: input.postalCode ?? null,
          country: input.country ?? null,
          phone: input.phone ?? null,
          email: input.email ?? null,
          websiteUrl: input.websiteUrl ?? null,
          listingUrl: input.listingUrl ?? null,
          rating: input.rating ?? null,
          reviewCount: input.reviewCount ?? null,
          services: input.services ?? null,
          websiteStatus: input.websiteStatus ?? "unknown",
          pipelineStatus: "new",
        })
        .returning();

      if (!lead) throw new Error("Insert returned no rows");

      // Step 5: provenance + activity inside tx
      const provenanceRecords = buildSourceRecords(
        leadId,
        ownerId,
        input as Record<string, unknown>,
        "user_provided",
      );
      if (provenanceRecords.length > 0) {
        await tx.insert(leadSourcesTable).values(provenanceRecords);
      }
      await appendActivity(
        { leadId, ownerId, activityType: "created", note: "Lead created manually", performedBy: ownerId },
        tx,
      );

      return { kind: "ok", lead };
    });

    if (txResult.kind === "duplicate") {
      res.status(409).json({
        error: "A lead matching this business already exists.",
        duplicateLeadId: txResult.duplicateLeadId,
      });
      return;
    }

    // Score runs outside the lock transaction (pure compute, no dup-identifying writes)
    const scored = await runAndPersistScore(leadId, ownerId, txResult.lead);
    res.status(201).json(CreateLeadResponse.parse(serializeLead(scored)));
  },
);

// ─── POST /leads/import ───────────────────────────────────────────────────────
//
// Advisory lock protocol:
//   tx start → acquireOwnerDuplicateLock → fetch existing → process all items
//   → tx commit → lock released
//   Lock is held for the entire batch — no concurrent imports for same owner
//   can interleave.  Score persistence runs outside the tx per-item.

leadsRouter.post(
  "/leads/import",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const body = ImportLeadsBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const { items } = body.data;
    if (!items || items.length === 0 || items.length > 100) {
      res.status(400).json({ error: "items must be an array with 1–100 items." });
      return;
    }

    type ItemResult = {
      index: number;
      status: "created" | "skipped";
      leadId: string | null;
      duplicateLeadId: string | null;
      error: string | null;
    };

    // Collect IDs of created leads so we can score them after the tx commits
    const createdLeads: Array<{ id: string; lead: typeof leadsTable.$inferSelect }> = [];

    const txResults = await db.transaction(async (tx): Promise<ItemResult[]> => {
      // Step 1: acquire owner-scoped advisory lock for entire batch
      await acquireOwnerDuplicateLock(tx, ownerId);

      // Step 2: read existing leads once inside the lock boundary
      const localExisting = await fetchLeadsForDuplicateCheckTx(tx, ownerId);

      const results: ItemResult[] = [];
      let created = 0;
      let skipped = 0;

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;

        // Step 3: check for duplicate (localExisting grows with each new insert)
        const duplicateLeadId = findDuplicate(
          {
            phone: item.phone ?? undefined,
            email: item.email ?? undefined,
            websiteUrl: item.websiteUrl ?? undefined,
            businessName: item.businessName,
            city: item.city ?? undefined,
          },
          localExisting,
        );

        if (duplicateLeadId) {
          results.push({ index: i, status: "skipped", leadId: null, duplicateLeadId, error: null });
          skipped++;
          continue;
        }

        // Clamp reviewCount to safe integer
        const reviewCount =
          item.reviewCount != null &&
          Number.isSafeInteger(item.reviewCount) &&
          item.reviewCount >= 0
            ? item.reviewCount
            : null;

        const id = newId();

        const [lead] = await tx
          .insert(leadsTable)
          .values({
            id,
            ownerId,
            businessName: item.businessName,
            category: item.category ?? null,
            description: item.description ?? null,
            address: item.address ?? null,
            city: item.city ?? null,
            region: item.region ?? null,
            postalCode: item.postalCode ?? null,
            country: item.country ?? null,
            phone: item.phone ?? null,
            email: item.email ?? null,
            websiteUrl: item.websiteUrl ?? null,
            listingUrl: item.listingUrl ?? null,
            rating: item.rating ?? null,
            reviewCount,
            services: item.services ?? null,
            websiteStatus: item.websiteStatus ?? "unknown",
            pipelineStatus: "new",
            sourceProvider: item.sourceProvider ?? null,
            sourceReference: item.sourceReference ?? null,
          })
          .returning();

        if (!lead) {
          results.push({ index: i, status: "skipped", leadId: null, duplicateLeadId: null, error: "Insert failed" });
          skipped++;
          continue;
        }

        const provenanceRecords = buildSourceRecords(
          id,
          ownerId,
          item as Record<string, unknown>,
          "imported",
        );
        if (provenanceRecords.length > 0) {
          await tx.insert(leadSourcesTable).values(provenanceRecords);
        }

        await appendActivity(
          {
            leadId: id,
            ownerId,
            activityType: "imported",
            note: item.sourceProvider ? `Imported from ${item.sourceProvider}` : "Imported",
            performedBy: ownerId,
          },
          tx,
        );

        // Track in local list for within-batch duplicate detection
        localExisting.push({
          id,
          phone: item.phone ?? null,
          email: item.email ?? null,
          websiteUrl: item.websiteUrl ?? null,
          businessName: item.businessName,
          city: item.city ?? null,
        });

        createdLeads.push({ id, lead });
        results.push({ index: i, status: "created", leadId: id, duplicateLeadId: null, error: null });
        created++;
      }

      return results;
    });

    // Score each created lead outside the lock tx (pure compute, no dup writes)
    for (const { id, lead } of createdLeads) {
      await runAndPersistScore(id, ownerId, lead);
    }

    const created = txResults.filter((r) => r.status === "created").length;
    const skipped = txResults.filter((r) => r.status === "skipped").length;

    res.json(ImportLeadsResponse.parse({ results: txResults, created, skipped }));
  },
);

// ─── GET /leads/:leadId ────────────────────────────────────────────────────────

leadsRouter.get(
  "/leads/:leadId",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = GetLeadParams.safeParse(req.params);
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

    // Fetch latest score reasons for detail view
    const [latestScore] = await db
      .select()
      .from(leadScoresTable)
      .where(and(eq(leadScoresTable.leadId, leadId), eq(leadScoresTable.ownerId, ownerId)))
      .orderBy(desc(leadScoresTable.scoredAt))
      .limit(1);

    const scoreReasons = latestScore
      ? (latestScore.reasons as unknown as Array<{
          key: string;
          label: string;
          points: number;
          weight: number;
        }>)
      : [];

    const scoreSummary = {
      ...buildScoreSummary(lead),
      reasons: scoreReasons,
    };

    // Suppression detail (with reason and timestamp)
    const [suppression] = await db
      .select()
      .from(leadSuppressionsTable)
      .where(
        and(
          eq(leadSuppressionsTable.leadId, leadId),
          eq(leadSuppressionsTable.ownerId, ownerId),
        ),
      )
      .limit(1);

    const suppressionSummary = {
      ...buildSuppressionSummary(lead),
      reason: suppression?.reason ?? null,
      suppressedAt: suppression?.suppressedAt
        ? suppression.suppressedAt.toISOString()
        : null,
    };

    // Source provenance records
    const sources = await db
      .select()
      .from(leadSourcesTable)
      .where(and(eq(leadSourcesTable.leadId, leadId), eq(leadSourcesTable.ownerId, ownerId)))
      .orderBy(leadSourcesTable.recordedAt);

    // Activity history (most recent first, capped at 50)
    const activities = await db
      .select()
      .from(leadActivitiesTable)
      .where(
        and(
          eq(leadActivitiesTable.leadId, leadId),
          eq(leadActivitiesTable.ownerId, ownerId),
        ),
      )
      .orderBy(desc(leadActivitiesTable.occurredAt))
      .limit(50);

    const leadRecord = { ...serializeLead(lead), scoreSummary, suppressionSummary };

    res.json(
      GetLeadResponse.parse({
        lead: leadRecord,
        sources: sources.map((s) => ({
          id: s.id,
          fieldName: s.fieldName,
          value: s.value ?? null,
          provenance: s.provenance as
            | "user_provided"
            | "imported"
            | "verified"
            | "inferred"
            | "ai_generated"
            | "provider",
          provider: s.provider ?? null,
          recordedAt: s.recordedAt,
        })),
        activities: activities.map((a) => ({
          id: a.id,
          activityType: a.activityType,
          note: a.note ?? null,
          performedBy: a.performedBy ?? null,
          occurredAt: a.occurredAt,
        })),
      }),
    );
  },
);

// ─── PATCH /leads/:leadId ─────────────────────────────────────────────────────
//
// Advisory lock protocol (only when identifying fields change):
//   tx start → acquireOwnerDuplicateLock → fetch others → findDuplicate
//   → update lead → insert provenance → tx commit → lock released
//   Score persistence runs outside the tx.
//
// When no identifying field changes, there is no duplicate risk, so no lock is
// acquired and the update runs without a transaction wrapper.

leadsRouter.patch(
  "/leads/:leadId",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = UpdateLeadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = UpdateLeadBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const input = body.data;

    // Validate reviewCount up-front
    if (
      input.reviewCount !== undefined &&
      input.reviewCount !== null &&
      (!Number.isSafeInteger(input.reviewCount) || input.reviewCount < 0)
    ) {
      res.status(400).json({ error: "reviewCount must be a safe non-negative integer." });
      return;
    }

    const identifyingFieldChanged = DUPLICATE_IDENTIFYING_FIELDS.some(
      (f) => f in input && (input as Record<string, unknown>)[f] !== undefined,
    );

    // Build the DB update object. null values explicitly clear the column.
    const buildUpdates = (existing: typeof leadsTable.$inferSelect) => {
      const updates: Partial<typeof leadsTable.$inferInsert> = { updatedAt: new Date() };
      if (input.businessName !== undefined) updates.businessName = input.businessName;
      if (input.category !== undefined) updates.category = input.category ?? null;
      if (input.description !== undefined) updates.description = input.description ?? null;
      if (input.address !== undefined) updates.address = input.address ?? null;
      if (input.city !== undefined) updates.city = input.city ?? null;
      if (input.region !== undefined) updates.region = input.region ?? null;
      if (input.postalCode !== undefined) updates.postalCode = input.postalCode ?? null;
      if (input.country !== undefined) updates.country = input.country ?? null;
      if (input.phone !== undefined) updates.phone = input.phone ?? null;
      if (input.email !== undefined) updates.email = input.email ?? null;
      if (input.websiteUrl !== undefined) updates.websiteUrl = input.websiteUrl ?? null;
      if (input.listingUrl !== undefined) updates.listingUrl = input.listingUrl ?? null;
      if (input.rating !== undefined) updates.rating = input.rating ?? null;
      if (input.reviewCount !== undefined) updates.reviewCount = input.reviewCount ?? null;
      if (input.services !== undefined) updates.services = input.services ?? null;
      if (input.pipelineStatus !== undefined) updates.pipelineStatus = input.pipelineStatus;
      if (input.websiteStatus !== undefined) updates.websiteStatus = input.websiteStatus;
      return updates;
    };

    // Build the duplicate-check candidate using null-safe overlay:
    // A null in input explicitly clears the field (treat as undefined for dup check).
    const buildCandidate = (existing: typeof leadsTable.$inferSelect) => ({
      businessName: input.businessName ?? existing.businessName,
      phone:
        "phone" in input
          ? (input.phone ?? null) ?? undefined
          : (existing.phone ?? undefined),
      email:
        "email" in input
          ? (input.email ?? null) ?? undefined
          : (existing.email ?? undefined),
      websiteUrl:
        "websiteUrl" in input
          ? (input.websiteUrl ?? null) ?? undefined
          : (existing.websiteUrl ?? undefined),
      city:
        "city" in input
          ? (input.city ?? null) ?? undefined
          : (existing.city ?? undefined),
    });

    type TxResult =
      | { kind: "not_found" }
      | { kind: "duplicate"; duplicateLeadId: string }
      | { kind: "ok"; lead: typeof leadsTable.$inferSelect; changedFields: string[] };

    // PATCH can change the recipient (email), provenance-approved facts, and
    // pipeline/website eligibility — all read by an in-flight Gmail draft
    // attempt. It MUST therefore hold the SAME shared per-(owner,lead) lock as
    // outreach/Gmail, held OUTER. Inside, the per-owner duplicate xact lock is
    // acquired INNER (lead-lock → owner-xact-lock) — a single global ordering
    // that cannot deadlock with the owner duplicate lock. Rescoring runs in a
    // second transaction on the SAME locked connection so it also stays under
    // the lock. All DB work uses lockedDb, never the global db.
    const { txResult, finalLead } = await withLeadMutationLock(
      ownerId,
      leadId,
      async (lockedDb) => {
        const txResult = await lockedDb.transaction(async (tx): Promise<TxResult> => {
          // Owner duplicate lock is acquired INNER, only when identifying fields
          // change. Ordering is always lead-lock (outer) → owner-xact-lock (inner).
          if (identifyingFieldChanged) {
            await acquireOwnerDuplicateLock(tx, ownerId);
          }

          // Fetch current lead inside tx
          const [existing] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1);

          if (!existing) return { kind: "not_found" };

          // Duplicate check (only when identifying fields change)
          if (identifyingFieldChanged) {
            const othersForCheck = await fetchLeadsForDuplicateCheckTx(tx, ownerId, leadId);
            const duplicateLeadId = findDuplicate(buildCandidate(existing), othersForCheck);
            if (duplicateLeadId) return { kind: "duplicate", duplicateLeadId };
          }

          const updates = buildUpdates(existing);

          const [updated] = await tx
            .update(leadsTable)
            .set(updates)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .returning();

          if (!updated) return { kind: "not_found" };

          // Provenance/activity are derived from ACTUAL before/after changes via
          // the single shared helper (recordLeadEditProvenance) — never from
          // payload presence. Values come from the updated stored row.
          const changedFields = await recordLeadEditProvenance(tx, {
            ownerId,
            leadId,
            existing,
            updated,
            input,
            performedBy: ownerId,
          });

          return { kind: "ok", lead: updated, changedFields };
        });

        // Rescore under the lock (second tx on the locked connection).
        let finalLead = txResult.kind === "ok" ? txResult.lead : null;
        if (txResult.kind === "ok") {
          const needsRescore = SCORE_RELEVANT_FIELDS.some(
            (f) => f in input && (input as Record<string, unknown>)[f] !== undefined,
          );
          if (needsRescore) {
            finalLead = await lockedDb.transaction((tx) =>
              runAndPersistScore(leadId, ownerId, txResult.lead, tx),
            );
          }
        }
        return { txResult, finalLead };
      },
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (patch)"),
    );

    if (txResult.kind === "not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (txResult.kind === "duplicate") {
      res.status(409).json({
        error: "These changes would create a duplicate lead.",
        duplicateLeadId: txResult.duplicateLeadId,
      });
      return;
    }

    res.json(UpdateLeadResponse.parse(serializeLead(finalLead ?? txResult.lead)));
  },
);

// ─── POST /leads/:leadId/score ────────────────────────────────────────────────

leadsRouter.post(
  "/leads/:leadId/score",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = ScoreLeadNowParams.safeParse(req.params);
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

    const scored = await runAndPersistScore(leadId, ownerId, lead);
    res.json(ScoreLeadNowResponse.parse(serializeLead(scored)));
  },
);
