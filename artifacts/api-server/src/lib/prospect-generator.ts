/**
 * Prospect site generator.
 *
 * Creates a full editable SiteProject from a verified subset of lead fields.
 * The resulting project is prospect-safe:
 *   - No testimonials, stats, team, FAQ claims, credentials, guarantees,
 *     receptionist, external URLs, or media.
 *   - Services listed with title only; descriptions are blank.
 *   - No fallback contact claims (phone/email only included if field selected
 *     and value exists in the lead).
 *   - prospectMeta marks the project as a draft.
 *   - Customer project generation is fully unaffected.
 *
 * Content rules (no invented copy):
 *   - Hero subtitle: uses stored description if selected; otherwise empty.
 *   - Contact-form subtitle: uses stored city if selected; otherwise empty.
 *   - Missing category/city/contact renders as omitted — no fallback text.
 *   - No phrases like "Professional ... you can rely on",
 *     "Serving ... and surrounding areas", or "We would love to hear from you."
 *   - business.category defaults to empty string (not 'Services') when absent.
 *
 * The project id equals the website id so Studio imports and API lookups
 * are aligned.
 */

import type { Lead } from "@workspace/db";
import type {
  SiteProject,
  PageId,
  PageData,
  SectionData,
  TemplateId,
  DesignTokens,
} from "@workspace/siteforge-core";

// ─── Template design tokens (mirrors templates.ts in studio) ─────────────────

const TEMPLATE_TOKENS: Record<TemplateId, DesignTokens> = {
  "home-services": { primaryColor: "#ef5d3f", fontHeading: "Manrope", fontBody: "Inter", borderRadius: "lg", buttonStyle: "solid" },
  advisor:        { primaryColor: "#1e3a8a", fontHeading: "Playfair Display", fontBody: "Inter", borderRadius: "sm", buttonStyle: "solid" },
  cafe:           { primaryColor: "#d97706", fontHeading: "Fraunces", fontBody: "DM Sans", borderRadius: "md", buttonStyle: "outline" },
  wellness:       { primaryColor: "#059669", fontHeading: "Outfit", fontBody: "Outfit", borderRadius: "full", buttonStyle: "solid" },
  creative:       { primaryColor: "#171717", fontHeading: "Space Mono", fontBody: "Inter", borderRadius: "none", buttonStyle: "solid" },
  plumber:        { primaryColor: "#0f6cbd", fontHeading: "Manrope", fontBody: "Inter", borderRadius: "md", buttonStyle: "solid" },
  electrician:    { primaryColor: "#f59e0b", fontHeading: "Outfit", fontBody: "Inter", borderRadius: "sm", buttonStyle: "solid" },
  carpenter:      { primaryColor: "#8b5e3c", fontHeading: "Fraunces", fontBody: "DM Sans", borderRadius: "sm", buttonStyle: "solid" },
};

// ─── Allowed fields ──────────────────────────────────────────────────────────

export const PROSPECT_ALLOWED_FIELDS = new Set([
  "businessName",
  "category",
  "description",
  "city",
  "region",
  "address",
  "postalCode",
  "country",
  "phone",
  "email",
  "services",
]);

type VerifiedFieldsMap = Partial<Record<string, boolean>>;

/**
 * Build the verified field snapshot — the actual values from the lead that
 * were selected via verifiedFields. Used for audit/display; not for generation
 * (values are re-read from the lead row directly).
 */
export function buildVerifiedFieldsSnapshot(
  lead: Lead,
  verifiedFields: VerifiedFieldsMap,
): Record<string, string | null> {
  const snapshot: Record<string, string | null> = {};
  for (const field of PROSPECT_ALLOWED_FIELDS) {
    if (verifiedFields[field]) {
      snapshot[field] = (lead as unknown as Record<string, string | null>)[field] ?? null;
    }
  }
  return snapshot;
}

/**
 * Generate a prospect-safe SiteProject.
 *
 * Rules:
 *   - Project id = websiteId
 *   - prospectMeta.isDraft = true
 *   - businessName is required; others are conditional on verifiedFields
 *   - Services: titles only; descriptions blank
 *   - No receptionist, no testimonials, no stats, no team, no gallery, no FAQ
 *   - No fallback contact claims; contact section only if phone or email present
 *   - No invented copy; neutral structural labels only ("Our Services", "About Us")
 *   - City/location only if field selected and value present
 *   - Hero subtitle: stored description only (empty if absent/not selected)
 *   - Contact-form subtitle: stored city only (empty if absent/not selected)
 *   - business.category: empty string if category not selected or absent
 */
export function generateProspectProject(params: {
  websiteId: string;
  lead: Lead;
  verifiedFields: VerifiedFieldsMap;
  templateId: TemplateId;
  generationId: string;
}): SiteProject {
  const { websiteId, lead, verifiedFields, templateId, generationId } = params;

  const tokens = TEMPLATE_TOKENS[templateId] ?? TEMPLATE_TOKENS["home-services"];

  // ── Business info ────────────────────────────────────────────────────────
  const businessName = lead.businessName; // always required
  // Only include category/city/etc if field selected AND value present in lead
  const category = verifiedFields.category && lead.category ? lead.category : "";
  const city = verifiedFields.city && lead.city ? lead.city : "";
  const phone = verifiedFields.phone && lead.phone ? lead.phone : "";
  const email = verifiedFields.email && lead.email ? lead.email : "";
  const description = verifiedFields.description && lead.description ? lead.description : "";

  const now = Date.now();

  // ── Parse services list ─────────────────────────────────────────────────
  // services field is a comma-separated or newline-separated list of service titles
  const servicesTitles: string[] = [];
  if (verifiedFields.services && lead.services) {
    const raw = lead.services.trim();
    if (raw) {
      const parts = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      servicesTitles.push(...parts.slice(0, 6)); // limit to 6 services
    }
  }

  // ── Build pages ─────────────────────────────────────────────────────────
  const pages: Record<PageId, PageData> = {
    home: { id: "home", name: "Home", sections: [] },
    about: { id: "about", name: "About", sections: [] },
    services: { id: "services", name: "Services", sections: [] },
    contact: { id: "contact", name: "Contact", sections: [] },
  };
  const sectionOrder: Record<PageId, string[]> = {
    home: [],
    about: [],
    services: [],
    contact: [],
  };
  const hiddenSections: Record<PageId, string[]> = {
    home: [],
    about: [],
    services: [],
    contact: [],
  };

  // Helper to add a section
  let sectionCounter = 0;
  function addSection(pageId: PageId, section: Omit<SectionData, "id"> & { id?: string }): string {
    sectionCounter++;
    const id: string = section.id ?? `s${sectionCounter}`;
    const full: SectionData = { ...section, id } as SectionData;
    pages[pageId].sections.push(full);
    sectionOrder[pageId].push(id);
    return id;
  }

  // ── Home page ────────────────────────────────────────────────────────────
  // Hero section — always included.
  // subtitle: use stored description if present; otherwise empty (no invented copy).
  addSection("home", {
    type: "hero",
    title: businessName,
    // No fallback like "Professional ... you can rely on" — use description or empty.
    subtitle: description,
    // CTA only if contact info present; otherwise neutral "Learn More"
    content: (phone || email) ? "Get in Touch" : "Learn More",
  });

  // Services/features on home — only if we have service titles
  if (servicesTitles.length > 0) {
    addSection("home", {
      type: "services-list",
      title: "Our Services",
      subtitle: "",
      items: servicesTitles.map((title) => ({ title, description: "" })),
    });
  }

  // Contact form on home — only if we have phone or email.
  // subtitle: city if present; otherwise empty (no "We would love to hear from you.").
  if (phone || email) {
    addSection("home", {
      type: "contact-form",
      title: "Get in Touch",
      // No fallback invented text — city or empty
      subtitle: city ? `Based in ${city}.` : "",
    });
  }

  // ── About page ───────────────────────────────────────────────────────────
  // About section — only if we have a description
  if (description) {
    addSection("about", {
      type: "about-text",
      title: `About ${businessName}`,
      content: description,
    });
    // Add contact to about too
    if (phone || email) {
      addSection("about", {
        type: "contact-form",
        title: "Contact Us",
        subtitle: "",
      });
    }
  }

  // ── Services page ─────────────────────────────────────────────────────────
  if (servicesTitles.length > 0) {
    addSection("services", {
      type: "services-list",
      title: "Our Services",
      subtitle: description || "",
      items: servicesTitles.map((title) => ({ title, description: "" })),
    });
    if (phone || email) {
      addSection("services", {
        type: "contact-form",
        title: "Get in Touch",
        subtitle: "",
      });
    }
  }

  // ── Contact page ──────────────────────────────────────────────────────────
  // Only if we have phone or email.
  // No "We would love to hear from you." fallback — city or empty.
  if (phone || email) {
    addSection("contact", {
      type: "contact-form",
      title: "Contact Us",
      subtitle: city ? `Based in ${city}.` : "",
    });
  }

  // ── Assemble SiteProject ─────────────────────────────────────────────────
  const project: SiteProject = {
    id: websiteId,
    name: businessName,
    createdAt: now,
    updatedAt: now,
    activePageId: "home",
    templateId,
    designTokens: tokens,
    business: {
      name: businessName,
      // Empty string when category absent/not selected — never invent 'Services'
      category: category,
      city: city,
      phone: phone,
      email: email,
    },
    pages,
    sectionOrder,
    hiddenSections,
    // No receptionist (prospect-safe: no external URLs, no credentials)
    prospectMeta: {
      isDraft: true,
      leadId: lead.id,
      generationId,
    },
  };

  return project;
}

/**
 * Validate that a generated (or loaded) SiteProject is prospect-safe for
 * preview delivery. Returns an error message or null if safe.
 *
 * Disallows:
 *   - Receptionist enabled
 *   - Visible testimonials
 *   - Visible stats
 *   - Visible team sections
 *   - prospectMeta missing or isDraft !== true
 */
export function validateProspectSafeProject(project: SiteProject): string | null {
  // Must have prospectMeta
  if (!project.prospectMeta || project.prospectMeta.isDraft !== true) {
    return "Project is not marked as a prospect draft.";
  }

  // No receptionist
  if (project.receptionist?.enabled) {
    return "Prospect site preview cannot have receptionist enabled.";
  }

  // No visible testimonials, stats, or team
  const banned: Array<string> = ["testimonials", "stats", "team"];
  for (const pageId of Object.keys(project.pages) as PageId[]) {
    const page = project.pages[pageId];
    const hidden = project.hiddenSections[pageId] ?? [];
    const order = project.sectionOrder[pageId] ?? [];
    const visible = order.filter((id) => !hidden.includes(id));
    for (const sectionId of visible) {
      const section = page.sections.find((s) => s.id === sectionId);
      if (section && banned.includes(section.type)) {
        return `Prospect site preview cannot include visible ${section.type} section.`;
      }
    }
  }

  return null;
}
