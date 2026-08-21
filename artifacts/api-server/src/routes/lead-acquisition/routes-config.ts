/**
 * Lead acquisition: config and dashboard routes.
 *
 * GET /lead-acquisition/config
 * GET /lead-acquisition/dashboard
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  leadsTable,
  leadActivitiesTable,
} from "@workspace/db";
import {
  GetLeadAcquisitionConfigResponse,
  GetLeadAcquisitionDashboardResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../../middlewares/requireAuth";
import { getLeadAcquisitionConfig } from "../../lib/lead-feature-state";
import { requireFeatureEnabled } from "./helpers";

export const configRouter: IRouter = Router();

// ─── GET /lead-acquisition/config ─────────────────────────────────────────────

configRouter.get(
  "/lead-acquisition/config",
  requireAuth,
  async (_req, res): Promise<void> => {
    res.json(GetLeadAcquisitionConfigResponse.parse(getLeadAcquisitionConfig()));
  },
);

// ─── GET /lead-acquisition/dashboard ──────────────────────────────────────────

configRouter.get(
  "/lead-acquisition/dashboard",
  requireAuth,
  requireFeatureEnabled,
  async (req, res): Promise<void> => {
    const ownerId = req.sfUserId!;

    // Total leads
    const [{ count: totalRaw }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(eq(leadsTable.ownerId, ownerId));
    const totalLeads = Number(totalRaw ?? 0);

    // Suppressed count
    const [{ count: suppressedRaw }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(and(eq(leadsTable.ownerId, ownerId), eq(leadsTable.suppressed, true)));
    const suppressedLeads = Number(suppressedRaw ?? 0);

    // Pipeline counts
    const pipelineRows = await db
      .select({ status: leadsTable.pipelineStatus, count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(eq(leadsTable.ownerId, ownerId))
      .groupBy(leadsTable.pipelineStatus);

    const pipelineCounts: Record<string, number> = {
      new: 0, contacted: 0, qualified: 0, proposal: 0, won: 0, lost: 0, archived: 0,
    };
    for (const r of pipelineRows) pipelineCounts[r.status] = Number(r.count ?? 0);

    // Website status counts
    const wsRows = await db
      .select({ status: leadsTable.websiteStatus, count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(eq(leadsTable.ownerId, ownerId))
      .groupBy(leadsTable.websiteStatus);

    const websiteStatusCounts: Record<string, number> = {
      unknown: 0, has_website: 0, no_website: 0, placeholder: 0, outdated: 0,
    };
    for (const r of wsRows) websiteStatusCounts[r.status] = Number(r.count ?? 0);

    // Score band counts
    const bandRows = await db
      .select({ band: leadsTable.scoreBand, count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(eq(leadsTable.ownerId, ownerId))
      .groupBy(leadsTable.scoreBand);

    const scoreBandCounts = { low: 0, medium: 0, high: 0, unscored: 0 };
    for (const r of bandRows) {
      if (r.band === "low") scoreBandCounts.low = Number(r.count ?? 0);
      else if (r.band === "medium") scoreBandCounts.medium = Number(r.count ?? 0);
      else if (r.band === "high") scoreBandCounts.high = Number(r.count ?? 0);
      else scoreBandCounts.unscored += Number(r.count ?? 0);
    }

    // Average score (scored leads only)
    const [{ avg: avgRaw }] = await db
      .select({ avg: sql<string | null>`avg(score)` })
      .from(leadsTable)
      .where(and(eq(leadsTable.ownerId, ownerId), sql`score IS NOT NULL`));
    const averageScore = avgRaw != null ? Math.round(Number(avgRaw) * 10) / 10 : null;

    // Recent leads (last 10)
    const recentLeadRows = await db
      .select({
        id: leadsTable.id,
        businessName: leadsTable.businessName,
        pipelineStatus: leadsTable.pipelineStatus,
        score: leadsTable.score,
        createdAt: leadsTable.createdAt,
      })
      .from(leadsTable)
      .where(eq(leadsTable.ownerId, ownerId))
      .orderBy(desc(leadsTable.createdAt))
      .limit(10);

    const recentLeads = recentLeadRows.map((r) => ({
      id: r.id,
      businessName: r.businessName,
      pipelineStatus: r.pipelineStatus,
      score: r.score ?? null,
      createdAt: r.createdAt,
    }));

    // Recent activity (last 10)
    const recentActivityRows = await db
      .select({
        id: leadActivitiesTable.id,
        leadId: leadActivitiesTable.leadId,
        businessName: leadsTable.businessName,
        activityType: leadActivitiesTable.activityType,
        note: leadActivitiesTable.note,
        occurredAt: leadActivitiesTable.occurredAt,
      })
      .from(leadActivitiesTable)
      .innerJoin(leadsTable, eq(leadActivitiesTable.leadId, leadsTable.id))
      .where(eq(leadActivitiesTable.ownerId, ownerId))
      .orderBy(desc(leadActivitiesTable.occurredAt))
      .limit(10);

    const recentActivity = recentActivityRows.map((r) => ({
      id: r.id,
      leadId: r.leadId,
      businessName: r.businessName,
      activityType: r.activityType,
      note: r.note ?? null,
      occurredAt: r.occurredAt,
    }));

    res.json(
      GetLeadAcquisitionDashboardResponse.parse({
        totalLeads,
        suppressedLeads,
        averageScore,
        pipelineCounts: {
          new: pipelineCounts["new"] ?? 0,
          contacted: pipelineCounts["contacted"] ?? 0,
          qualified: pipelineCounts["qualified"] ?? 0,
          proposal: pipelineCounts["proposal"] ?? 0,
          won: pipelineCounts["won"] ?? 0,
          lost: pipelineCounts["lost"] ?? 0,
          archived: pipelineCounts["archived"] ?? 0,
        },
        websiteStatusCounts: {
          unknown: websiteStatusCounts["unknown"] ?? 0,
          has_website: websiteStatusCounts["has_website"] ?? 0,
          no_website: websiteStatusCounts["no_website"] ?? 0,
          placeholder: websiteStatusCounts["placeholder"] ?? 0,
          outdated: websiteStatusCounts["outdated"] ?? 0,
        },
        scoreBandCounts,
        recentLeads,
        recentActivity,
      }),
    );
  },
);
