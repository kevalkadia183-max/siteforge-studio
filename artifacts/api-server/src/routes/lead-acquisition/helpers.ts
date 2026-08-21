/**
 * Lead acquisition: shared helpers, types, and middleware.
 */

import { randomBytes } from "node:crypto";
import { type Request, type Response, type NextFunction } from "express";
import { isLeadAcquisitionEnabled } from "../../lib/lead-feature-state";
import {
  type LeadForScoring,
} from "../../lib/lead-scoring";
import { leadsTable } from "@workspace/db";

export type Lead = typeof leadsTable.$inferSelect;

/** Generate a short random hex id */
export function newId(): string {
  return randomBytes(12).toString("hex");
}

/** Middleware: reject with 403 if the lead-acquisition feature flag is off */
export function requireFeatureEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isLeadAcquisitionEnabled()) {
    res.status(403).json({ error: "Lead acquisition feature is not enabled." });
    return;
  }
  next();
}

/** Build the LeadScoreSummary sub-object from a lead row (no reasons; use detail endpoint) */
export function buildScoreSummary(lead: Lead) {
  return {
    score: lead.score ?? null,
    band: (lead.scoreBand as "low" | "medium" | "high" | null) ?? null,
    reasons: [] as Array<{ key: string; label: string; points: number; weight: number }>,
    scoredAt: lead.scoredAt ? lead.scoredAt.toISOString() : null,
  };
}

/** Build the LeadSuppressionSummary sub-object from a lead row */
export function buildSuppressionSummary(lead: Lead) {
  return {
    suppressed: lead.suppressed,
    reason: null as string | null,
    suppressedAt: null as string | null,
  };
}

/**
 * Serialize a DB lead row to a safe LeadRecord response.
 * ownerId is intentionally omitted — server-owned field.
 */
export function serializeLead(lead: Lead) {
  return {
    id: lead.id,
    // ownerId deliberately omitted — server-owned, not exposed in API
    businessName: lead.businessName,
    category: lead.category ?? null,
    description: lead.description ?? null,
    address: lead.address ?? null,
    city: lead.city ?? null,
    region: lead.region ?? null,
    postalCode: lead.postalCode ?? null,
    country: lead.country ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    websiteUrl: lead.websiteUrl ?? null,
    listingUrl: lead.listingUrl ?? null,
    rating: lead.rating ?? null,
    reviewCount: lead.reviewCount ?? null,
    services: lead.services ?? null,
    pipelineStatus: lead.pipelineStatus as
      | "new" | "contacted" | "qualified" | "proposal" | "won" | "lost" | "archived",
    websiteStatus: lead.websiteStatus as
      | "unknown" | "has_website" | "no_website" | "placeholder" | "outdated",
    sourceProvider: lead.sourceProvider ?? null,
    sourceReference: lead.sourceReference ?? null,
    sourceState: lead.sourceState ?? null,
    scoreSummary: buildScoreSummary(lead),
    suppressionSummary: buildSuppressionSummary(lead),
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

/** Build a LeadForScoring from a DB row */
export function leadForScoring(lead: Lead): LeadForScoring {
  return {
    businessName: lead.businessName,
    phone: lead.phone,
    email: lead.email,
    websiteUrl: lead.websiteUrl,
    websiteStatus: lead.websiteStatus as LeadForScoring["websiteStatus"],
    category: lead.category,
    city: lead.city,
    description: lead.description,
    services: lead.services,
    rating: lead.rating,
    reviewCount: lead.reviewCount, // integer | null — scoring engine accepts number | string | null
  };
}

/** Fields whose change triggers score recomputation */
export const SCORE_RELEVANT_FIELDS = [
  "phone",
  "email",
  "websiteUrl",
  "websiteStatus",
  "category",
  "city",
  "description",
  "services",
  "rating",
  "reviewCount",
] as const;

/** Fields for which we track source provenance */
export const PROVENANCE_TRACKED_FIELDS = [
  "businessName",
  "category",
  "phone",
  "email",
  "websiteUrl",
  "city",
  "region",
  "address",
  "description",
  "services",
  "websiteStatus",
] as const;

/** Fields that are "identifying" for duplicate detection on PATCH */
export const DUPLICATE_IDENTIFYING_FIELDS = [
  "phone",
  "email",
  "websiteUrl",
  "businessName",
  "city",
] as const;
