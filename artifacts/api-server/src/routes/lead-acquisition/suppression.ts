/**
 * Lead suppression handlers.
 *
 * PUT  /leads/:leadId/suppression  — suppress (DNC)
 * DELETE /leads/:leadId/suppression — unsuppress
 *
 * Race safety:
 *  - All state changes happen inside a single transaction.
 *  - We acquire a row-level lock on the lead row (SELECT FOR UPDATE) before
 *    reading+writing the lead and suppression table, so concurrent requests
 *    for the same lead serialize correctly.
 *  - The unique index (lead_id, owner_id) on suppressions prevents duplicate
 *    rows even if locking is bypassed. INSERT uses ON CONFLICT DO UPDATE so
 *    the operation is idempotent — re-suppressing with a new reason updates
 *    the existing row atomically.
 */

import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  leadsTable,
  leadSuppressionsTable,
} from "@workspace/db";
import { withLeadMutationLock } from "../../lib/lead-mutation-lock";
import { hasDurableOutreachOptOut } from "./outreach-ops";
import {
  SuppressLeadParams,
  SuppressLeadBody,
  SuppressLeadResponse,
  UnsuppressLeadParams,
  UnsuppressLeadResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { requireFeatureEnabled, serializeLead, newId } from "./helpers";
import { appendActivity } from "./lead-ops";

export const suppressionRouter: IRouter = Router();

// ─── PUT /leads/:leadId/suppression ───────────────────────────────────────────

suppressionRouter.put(
  "/leads/:leadId/suppression",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = SuppressLeadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    const body = SuppressLeadBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const { reason } = body.data;

    // Suppression changes DNC — it MUST hold the SAME shared per-(owner,lead)
    // lock as outreach/Gmail so it can never interleave with an in-flight Gmail
    // draft attempt. All DB work runs through the scoped lockedDb transaction.
    const result = await withLeadMutationLock(
      ownerId,
      leadId,
      (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          // Row-lock the lead as belt-and-suspenders under the session lock.
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1)
            .for("update");

          if (!lead) return { kind: "not_found" } as const;

          // FAIL-CLOSED: a permanent outreach opt-out owns the canonical
          // suppression row with its "Outreach opt-out" reason. An ordinary PUT
          // suppress must NOT overwrite that reason/timestamp/flag/activity —
          // otherwise the detail UI (which keys off the canonical reason) would
          // stop recognizing the permanent Do-Not-Contact even though DELETE
          // still 409s. Refuse BEFORE any write, using the SAME durable-opt-out
          // helper and the SAME permanent-conflict semantics as DELETE.
          if (await hasDurableOutreachOptOut(tx, ownerId, leadId)) {
            return { kind: "outreach_opt_out" } as const;
          }

          // Upsert suppression row — idempotent: re-suppress updates reason/time
          await tx
            .insert(leadSuppressionsTable)
            .values({
              id: newId(),
              leadId,
              ownerId,
              reason,
            })
            .onConflictDoUpdate({
              target: [leadSuppressionsTable.leadId, leadSuppressionsTable.ownerId],
              set: {
                reason,
                suppressedAt: new Date(),
              },
            });

          const [updated] = await tx
            .update(leadsTable)
            .set({ suppressed: true, updatedAt: new Date() })
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .returning();

          // Activity recorded inside the locked tx so it stays under the lock.
          await appendActivity(
            {
              leadId,
              ownerId,
              activityType: "suppressed",
              note: `Do Not Contact: ${reason}`,
              performedBy: ownerId,
            },
            tx,
          );

          return { kind: "ok", lead: updated! } as const;
        }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (suppress)"),
    );

    if (result.kind === "not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (result.kind === "outreach_opt_out") {
      res.status(409).json({
        error:
          "This lead has permanently opted out of outreach. That Do Not Contact status is canonical and cannot be overwritten by an ordinary suppression.",
      });
      return;
    }

    res.json(SuppressLeadResponse.parse(serializeLead(result.lead)));
  },
);

// ─── DELETE /leads/:leadId/suppression ────────────────────────────────────────

suppressionRouter.delete(
  "/leads/:leadId/suppression",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    const params = UnsuppressLeadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const { leadId } = params.data;

    // Unsuppress changes DNC — same shared per-(owner,lead) lock as outreach.
    const result = await withLeadMutationLock(
      ownerId,
      leadId,
      (lockedDb) =>
        lockedDb.transaction(async (tx) => {
          // Row-lock the lead as belt-and-suspenders under the session lock.
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1)
            .for("update");

          if (!lead) return { kind: "not_found" } as const;
          if (!lead.suppressed) return { kind: "not_suppressed" } as const;

          // A permanent outreach opt-out is a Do-Not-Contact signal that ordinary
          // unsuppress CANNOT negate. If a durable outreach opt-out row exists for
          // this owner+lead, refuse to clear the canonical suppression so prospect
          // generation, dashboards, and every other DNC consumer stay blocked.
          // Uses the SAME helper the outreach layer relies on so behavior cannot
          // drift between the two.
          if (await hasDurableOutreachOptOut(tx, ownerId, leadId)) {
            return { kind: "outreach_opt_out" } as const;
          }

          await tx
            .delete(leadSuppressionsTable)
            .where(
              and(
                eq(leadSuppressionsTable.leadId, leadId),
                eq(leadSuppressionsTable.ownerId, ownerId),
              ),
            );

          const [updated] = await tx
            .update(leadsTable)
            .set({ suppressed: false, updatedAt: new Date() })
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .returning();

          await appendActivity(
            {
              leadId,
              ownerId,
              activityType: "unsuppressed",
              note: "Do Not Contact flag removed",
              performedBy: ownerId,
            },
            tx,
          );

          return { kind: "ok", lead: updated! } as const;
        }),
      (error) => req.log.error({ error: String(error), leadId }, "Failed to release lead-mutation lock (unsuppress)"),
    );

    if (result.kind === "not_found") {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    if (result.kind === "not_suppressed") {
      res.status(404).json({ error: "Lead is not suppressed." });
      return;
    }
    if (result.kind === "outreach_opt_out") {
      res.status(409).json({
        error:
          "This lead has permanently opted out of outreach. That Do Not Contact status cannot be removed with unsuppress.",
      });
      return;
    }

    res.json(UnsuppressLeadResponse.parse(serializeLead(result.lead)));
  },
);
