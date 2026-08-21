/**
 * Maps lead category strings to SiteForge template IDs for prospect generation.
 * Case-insensitive matching via lowercase normalization.
 *
 * Only templates appropriate for prospect-safe generation are used.
 * If no category match is found, falls back to 'home-services' as the
 * neutral default.
 */

import type { TemplateId } from "@workspace/siteforge-core";

export const VALID_TEMPLATE_IDS = new Set<TemplateId>([
  "home-services",
  "advisor",
  "cafe",
  "wellness",
  "creative",
  "plumber",
  "electrician",
  "carpenter",
]);

/**
 * Keyword patterns → templateId.
 * Checked in order; first match wins.
 */
const CATEGORY_RULES: Array<{ keywords: string[]; template: TemplateId }> = [
  { keywords: ["plumber", "plumbing", "pipe", "drain", "water heater"], template: "plumber" },
  { keywords: ["electric", "electrician", "wiring", "panel", "circuit"], template: "electrician" },
  { keywords: ["carpenter", "carpentry", "cabinet", "woodwork", "joiner", "furniture maker"], template: "carpenter" },
  { keywords: ["cafe", "coffee", "restaurant", "bakery", "food", "catering", "bar", "bistro", "eatery", "diner"], template: "cafe" },
  { keywords: ["wellness", "spa", "massage", "yoga", "physio", "therapy", "chiropractic", "naturopath", "fitness", "gym", "personal trainer", "pilates", "health"], template: "wellness" },
  { keywords: ["advisor", "consultant", "accountant", "lawyer", "attorney", "financial", "insurance", "mortgage", "realtor", "real estate", "architect", "engineer", "tax"], template: "advisor" },
  { keywords: ["creative", "design", "photography", "video", "film", "graphic", "artist", "studio", "marketing", "brand", "web design"], template: "creative" },
];

/**
 * Derive a template ID from a category string.
 * Returns a valid TemplateId or 'home-services' as the default.
 */
export function templateFromCategory(category?: string | null): TemplateId {
  if (!category) return "home-services";
  const lower = category.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.template;
    }
  }
  return "home-services";
}

/**
 * Validate a client-supplied templateId override.
 * Returns true if the templateId is valid and may be used.
 */
export function isValidTemplateId(id: string): id is TemplateId {
  return VALID_TEMPLATE_IDS.has(id as TemplateId);
}
