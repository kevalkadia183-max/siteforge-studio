/**
 * Lead Opportunity Scoring Engine
 *
 * Deterministic, explainable scoring 0-100.
 * No external URL fetching or scraping.
 * Website status defaults to "unknown" and must never be treated as a confirmed problem.
 * Only explicit user choices (no_website, placeholder, outdated) generate
 * high-opportunity signals.
 */

export type WebsiteStatus =
  | "unknown"
  | "has_website"
  | "no_website"
  | "placeholder"
  | "outdated";

export interface LeadForScoring {
  businessName: string;
  phone?: string | null;
  email?: string | null;
  websiteUrl?: string | null;
  websiteStatus: WebsiteStatus;
  category?: string | null;
  city?: string | null;
  description?: string | null;
  services?: string | null;
  rating?: number | null;
  /** reviewCount is stored as integer in DB; pass null if not available */
  reviewCount?: number | string | null;
}

export interface ScoreReason {
  key: string;
  label: string;
  points: number;
  weight: number;
}

export interface ScoreResult {
  score: number;
  band: "low" | "medium" | "high";
  reasons: ScoreReason[];
  weightSnapshot: Record<string, number>;
}

/**
 * Weight snapshot — every scoring run stores this so historical
 * scores remain reproducible even if weights change in future.
 */
export const SCORE_WEIGHTS: Record<string, number> = {
  // Website opportunity signals (highest value)
  no_website: 40,
  placeholder_website: 35,
  outdated_website: 25,
  has_website: 0,
  // Unknown is NOT a confirmed problem — only a "verify first" note
  website_unknown: 0,

  // Contact completeness
  has_phone: 10,
  has_email: 8,

  // Business completeness
  has_category: 6,
  has_city: 4,
  has_description: 4,
  has_services: 4,

  // Social proof / engagement signals
  has_reviews: 5,
  high_rating: 4,
};

/**
 * Compute a deterministic opportunity score for a lead.
 * Returns score 0-100, band, reasons array, and the weight snapshot.
 *
 * Scoring rules:
 * - no_website  → very high opportunity (40 pts)
 * - placeholder → high opportunity (35 pts)
 * - outdated    → moderate-high opportunity (25 pts)
 * - has_website → no website opportunity bonus
 * - unknown     → 0 pts from website status, includes a verify-first reason
 *
 * Contact completeness adds points; unknown website explicitly warns
 * it is not a confirmed problem.
 */
export function computeLeadScore(lead: LeadForScoring): ScoreResult {
  const reasons: ScoreReason[] = [];
  let rawScore = 0;

  // ── Website status signal ──────────────────────────────────────────────────
  if (lead.websiteStatus === "no_website") {
    reasons.push({
      key: "no_website",
      label: "Business has no website — strong opportunity",
      points: SCORE_WEIGHTS.no_website,
      weight: SCORE_WEIGHTS.no_website,
    });
    rawScore += SCORE_WEIGHTS.no_website;
  } else if (lead.websiteStatus === "placeholder") {
    reasons.push({
      key: "placeholder_website",
      label: "Website is a placeholder — high opportunity for a real site",
      points: SCORE_WEIGHTS.placeholder_website,
      weight: SCORE_WEIGHTS.placeholder_website,
    });
    rawScore += SCORE_WEIGHTS.placeholder_website;
  } else if (lead.websiteStatus === "outdated") {
    reasons.push({
      key: "outdated_website",
      label: "Website appears outdated — moderate opportunity to modernize",
      points: SCORE_WEIGHTS.outdated_website,
      weight: SCORE_WEIGHTS.outdated_website,
    });
    rawScore += SCORE_WEIGHTS.outdated_website;
  } else if (lead.websiteStatus === "has_website") {
    // No opportunity from website; it's already covered
    reasons.push({
      key: "has_website",
      label: "Business already has a website",
      points: 0,
      weight: SCORE_WEIGHTS.has_website,
    });
  } else {
    // unknown — explicitly not a confirmed problem
    reasons.push({
      key: "website_unknown",
      label:
        "Website status is unknown — verify before treating as an opportunity",
      points: 0,
      weight: SCORE_WEIGHTS.website_unknown,
    });
  }

  // ── Contact completeness ───────────────────────────────────────────────────
  if (lead.phone && lead.phone.trim().length > 0) {
    reasons.push({
      key: "has_phone",
      label: "Phone number available for outreach",
      points: SCORE_WEIGHTS.has_phone,
      weight: SCORE_WEIGHTS.has_phone,
    });
    rawScore += SCORE_WEIGHTS.has_phone;
  }

  if (lead.email && lead.email.trim().length > 0) {
    reasons.push({
      key: "has_email",
      label: "Email address available for outreach",
      points: SCORE_WEIGHTS.has_email,
      weight: SCORE_WEIGHTS.has_email,
    });
    rawScore += SCORE_WEIGHTS.has_email;
  }

  // ── Business completeness ──────────────────────────────────────────────────
  if (lead.category && lead.category.trim().length > 0) {
    reasons.push({
      key: "has_category",
      label: "Business category is known",
      points: SCORE_WEIGHTS.has_category,
      weight: SCORE_WEIGHTS.has_category,
    });
    rawScore += SCORE_WEIGHTS.has_category;
  }

  if (lead.city && lead.city.trim().length > 0) {
    reasons.push({
      key: "has_city",
      label: "City is known for local targeting",
      points: SCORE_WEIGHTS.has_city,
      weight: SCORE_WEIGHTS.has_city,
    });
    rawScore += SCORE_WEIGHTS.has_city;
  }

  if (lead.description && lead.description.trim().length > 0) {
    reasons.push({
      key: "has_description",
      label: "Business description available",
      points: SCORE_WEIGHTS.has_description,
      weight: SCORE_WEIGHTS.has_description,
    });
    rawScore += SCORE_WEIGHTS.has_description;
  }

  if (lead.services && lead.services.trim().length > 0) {
    reasons.push({
      key: "has_services",
      label: "Services list available for proposal tailoring",
      points: SCORE_WEIGHTS.has_services,
      weight: SCORE_WEIGHTS.has_services,
    });
    rawScore += SCORE_WEIGHTS.has_services;
  }

  // ── Social proof ───────────────────────────────────────────────────────────
  const reviewCount =
    lead.reviewCount != null ? Number(lead.reviewCount) : null;
  if (reviewCount != null && !isNaN(reviewCount) && reviewCount > 0) {
    reasons.push({
      key: "has_reviews",
      label: `Business has ${reviewCount} review(s) — engaged with customers`,
      points: SCORE_WEIGHTS.has_reviews,
      weight: SCORE_WEIGHTS.has_reviews,
    });
    rawScore += SCORE_WEIGHTS.has_reviews;
  }

  if (lead.rating != null && lead.rating >= 4.0) {
    reasons.push({
      key: "high_rating",
      label: `Rating ${lead.rating.toFixed(1)} — strong reputation signal`,
      points: SCORE_WEIGHTS.high_rating,
      weight: SCORE_WEIGHTS.high_rating,
    });
    rawScore += SCORE_WEIGHTS.high_rating;
  }

  // ── Normalize to 0-100 ────────────────────────────────────────────────────
  const maxPossible =
    SCORE_WEIGHTS.no_website + // best website signal
    SCORE_WEIGHTS.has_phone +
    SCORE_WEIGHTS.has_email +
    SCORE_WEIGHTS.has_category +
    SCORE_WEIGHTS.has_city +
    SCORE_WEIGHTS.has_description +
    SCORE_WEIGHTS.has_services +
    SCORE_WEIGHTS.has_reviews +
    SCORE_WEIGHTS.high_rating;

  const normalized = Math.round((rawScore / maxPossible) * 100);
  const score = Math.min(100, Math.max(0, normalized));

  const band: "low" | "medium" | "high" =
    score >= 60 ? "high" : score >= 30 ? "medium" : "low";

  return {
    score,
    band,
    reasons,
    weightSnapshot: { ...SCORE_WEIGHTS },
  };
}
