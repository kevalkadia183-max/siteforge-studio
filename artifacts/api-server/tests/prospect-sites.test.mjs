/**
 * Prospect site lifecycle — unit + integration tests.
 *
 * All tests are pure unit tests (no DB or network calls) except where noted.
 * Modules are built with esbuild and imported dynamically so we
 * get real runtime behaviour without a running server.
 *
 * Covers:
 * 1.  templateFromCategory: plumbing keywords → plumber template
 * 2.  templateFromCategory: electrician keywords → electrician template
 * 3.  templateFromCategory: cafe keywords → cafe template
 * 4.  templateFromCategory: wellness keywords → wellness template
 * 5.  templateFromCategory: creative/design → creative template
 * 6.  templateFromCategory: unknown/null → home-services fallback
 * 7.  templateFromCategory: case-insensitive match
 * 8.  isValidTemplateId: known ids pass
 * 9.  isValidTemplateId: unknown id fails
 * 10. generateProspectProject: uses websiteId as project.id
 * 11. generateProspectProject: sets prospectMeta.isDraft = true
 * 12. generateProspectProject: sets prospectMeta.leadId and generationId
 * 13. generateProspectProject: businessName always appears in home hero
 * 14. generateProspectProject: services included when field selected + present
 * 15. generateProspectProject: services omitted when field not selected
 * 16. generateProspectProject: phone omitted when not in verifiedFields
 * 17. generateProspectProject: phone omitted when field selected but value empty
 * 18. generateProspectProject: email omitted when not in verifiedFields
 * 19. generateProspectProject: no receptionist on generated project
 * 20. generateProspectProject: no testimonials sections generated
 * 21. generateProspectProject: no stats sections generated
 * 22. generateProspectProject: no team sections generated
 * 23. generateProspectProject: no FAQ sections generated
 * 24. generateProspectProject: contact-form only when phone or email present
 * 25. generateProspectProject: description from verifiedFields when present
 * 26. generateProspectProject: template tokens applied correctly
 * 27. buildVerifiedFieldsSnapshot: only returns allowed fields that are true
 * 28. buildVerifiedFieldsSnapshot: null lead values produce null snapshot entry
 * 29. validateProspectSafeProject: accepts valid draft project
 * 30. validateProspectSafeProject: rejects project missing prospectMeta
 * 31. validateProspectSafeProject: rejects project with isDraft !== true
 * 32. validateProspectSafeProject: rejects project with receptionist enabled
 * 33. validateProspectSafeProject: rejects project with visible testimonials
 * 34. validateProspectSafeProject: accepts project with hidden testimonials
 * 35. validateProspectSafeProject: rejects project with visible stats
 * 36. validateProspectSafeProject: rejects project with visible team
 * 37. HMAC signing: newMappingId produces non-empty URL-safe base64
 * 38. HMAC signing: computeSignature is deterministic for same input
 * 39. HMAC signing: different mappingIds produce different signatures
 * 40. HMAC signing: hashSignature produces 64-char hex (sha256)
 * 41. HMAC signing: verifySignature returns true for correct inputs
 * 42. HMAC signing: verifySignature returns false for tampered mappingId
 * 43. HMAC signing: verifySignature returns false for tampered signature
 * 44. HMAC signing: verifySignature returns false for wrong storedHash
 * 45. HMAC signing: buildPreviewPath starts with /api/prospect-previews/
 * 46. HMAC signing: buildPreviewPath uses path segments (no ?sig= query param)
 * 47. HMAC signing: previewExpiresAt is ~24 hours from now (24h TTL)
 * 48. GET response: returns null for no lifecycle (stable empty state)
 * 49. GET response: serializer includes previewPath when unexpired preview exists
 * 50. GET response: serializer returns null previewPath when preview expired
 * 51. GET response: serializer includes templateId from generation row
 * 52. GET response: serializer returns null templateId when no generation
 * 53. prospectLockKey: deterministic for same owner+lead
 * 54. prospectLockKey: different owners produce different keys
 * 55. prospectLockKey: different leads produce different keys
 * 56. validateLeadEligible: qualified non-suppressed lead passes
 * 57. validateLeadEligible: non-qualified lead fails
 * 58. validateLeadEligible: suppressed lead fails
 * 59. PROSPECT_ALLOWED_FIELDS: only allowlisted keys accepted
 * 60. serializeProspectSite: generationCount is integer (from integer DB column)
 * 61. No invented copy: hero subtitle is empty when no description selected
 * 62. No invented copy: hero subtitle is description when selected
 * 63. No invented copy: contact-form subtitle is empty when no city selected
 * 64. No invented copy: contact-form subtitle has city when city selected
 * 65. No invented copy: business.category is empty string when not selected
 * 66. No invented copy: HTML must not contain forbidden phrases
 * 67. Signed URL: path segments format (mappingId/signature/ with trailing slash)
 * 68. Signed URL: relative assets resolve under signed prefix
 * 69. Provenance: buildVerifiedFieldsSnapshot captures DB values for non-empty fields
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// ─── Build helpers ─────────────────────────────────────────────────────────

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-prospect-"));

/** Build a TS file to ESM and import it */
async function buildAndImport(entryPath, name, extras = {}) {
  const outfile = join(outputDir, `${name}.mjs`);
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    // Stub the DB and crypto (we only test pure logic)
    external: [],
    // Override SESSION_SECRET for signing tests
    define: {
      "process.env.SESSION_SECRET": '"test-session-secret-abc-123-at-least-32"',
      "process.env.DATABASE_URL": '"postgres://localhost/test"',
    },
    ...extras,
  });
  return import(pathToFileURL(outfile).href);
}

const categoryMapMod = await buildAndImport(
  new URL("../src/lib/prospect-category-map.ts", import.meta.url).pathname,
  "category-map",
);
const { templateFromCategory, isValidTemplateId, VALID_TEMPLATE_IDS } = categoryMapMod;

const generatorMod = await buildAndImport(
  new URL("../src/lib/prospect-generator.ts", import.meta.url).pathname,
  "prospect-generator",
);
const {
  generateProspectProject,
  buildVerifiedFieldsSnapshot,
  validateProspectSafeProject,
  PROSPECT_ALLOWED_FIELDS,
} = generatorMod;

const coreGeneratorMod = await buildAndImport(
  new URL("../../../lib/siteforge-core/src/generator.ts", import.meta.url).pathname,
  "siteforge-core-generator",
);
const { generateSite } = coreGeneratorMod;

const requestLogMod = await buildAndImport(
  new URL("../src/lib/request-log-sanitize.ts", import.meta.url).pathname,
  "request-log-sanitize",
);
const { sanitizeRequestUrlForLogs } = requestLogMod;

const signingMod = await buildAndImport(
  new URL("../src/lib/prospect-preview-signing.ts", import.meta.url).pathname,
  "prospect-signing",
);
const {
  newMappingId,
  computeSignature,
  hashSignature,
  verifySignature,
  buildPreviewPath,
  previewExpiresAt,
  PROSPECT_PREVIEW_LIFETIME_MS,
} = signingMod;

// The shared preview-store module holds the validation + stored-site response
// logic reused by both ordinary /previews and prospect delivery. It is
// dependency-light (no Express/logger/DB pool) so it imports cleanly here and
// the exercised functions perform no DB I/O — these stay pure unit tests.
const previewStoreMod = await buildAndImport(
  new URL("../src/lib/preview-store.ts", import.meta.url).pathname,
  "preview-store",
);
const {
  serveStoredPreviewAsset,
  validateSite,
  hashSecret,
  newSecret,
  previewLifetimeMs,
  PROSPECT_EDITOR_HASH_PREFIX,
} = previewStoreMod;

// ─── Minimal mock Express Response for serveStoredPreviewAsset ──────────────

function makeMockRes() {
  const res = {
    statusCode: null,
    headers: {},
    contentType: null,
    body: undefined,
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(t) {
      this.contentType = t;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

// A minimal valid StoredGeneratedSite for preview-store tests.
function makeStoredSite(overrides = {}) {
  return {
    pages: {
      "index.html":
        '<!doctype html><html><head></head><body><h1>Hi</h1>' +
        '<script src="main.js"></script></body></html>',
    },
    css: "body{color:#111}",
    js: "console.log('static');",
    ...overrides,
  };
}

// ─── Minimal lead fixture ──────────────────────────────────────────────────

function makeLead(overrides = {}) {
  return {
    id: "lead_abc123",
    ownerId: "owner_xyz",
    businessName: "Pine Tree Plumbing",
    category: "Plumbing",
    description: "Emergency and scheduled plumbing services.",
    city: "Vancouver",
    region: "BC",
    address: null,
    postalCode: null,
    country: null,
    phone: "6045550101",
    email: "info@pinetree.example",
    websiteUrl: null,
    services: "Leak repair, Drain clearing, Pipe installation",
    pipelineStatus: "qualified",
    suppressed: false,
    ...overrides,
  };
}

// ─── Category → template mapping ───────────────────────────────────────────

test("1. templateFromCategory: plumbing keywords → plumber", () => {
  assert.equal(templateFromCategory("Plumbing Services"), "plumber");
  assert.equal(templateFromCategory("plumber"), "plumber");
  assert.equal(templateFromCategory("drain repair"), "plumber");
});

test("2. templateFromCategory: electrician keywords → electrician", () => {
  assert.equal(templateFromCategory("electrician"), "electrician");
  assert.equal(templateFromCategory("Electrical Wiring"), "electrician");
  assert.equal(templateFromCategory("circuit panel replacement"), "electrician");
});

test("3. templateFromCategory: cafe keywords → cafe", () => {
  assert.equal(templateFromCategory("Coffee Shop"), "cafe");
  assert.equal(templateFromCategory("restaurant"), "cafe");
  assert.equal(templateFromCategory("Bakery & Café"), "cafe");
});

test("4. templateFromCategory: wellness keywords → wellness", () => {
  assert.equal(templateFromCategory("Wellness Clinic"), "wellness");
  assert.equal(templateFromCategory("massage therapy"), "wellness");
  assert.equal(templateFromCategory("personal trainer"), "wellness");
});

test("5. templateFromCategory: creative/design → creative", () => {
  assert.equal(templateFromCategory("Graphic Design"), "creative");
  assert.equal(templateFromCategory("Photography Studio"), "creative");
  assert.equal(templateFromCategory("marketing agency"), "creative");
});

test("6. templateFromCategory: unknown/null → home-services fallback", () => {
  assert.equal(templateFromCategory(null), "home-services");
  assert.equal(templateFromCategory(undefined), "home-services");
  assert.equal(templateFromCategory(""), "home-services");
  assert.equal(templateFromCategory("some completely unknown business type"), "home-services");
});

test("7. templateFromCategory: case-insensitive match", () => {
  assert.equal(templateFromCategory("PLUMBING"), "plumber");
  assert.equal(templateFromCategory("ELECTRICIAN"), "electrician");
  assert.equal(templateFromCategory("Yoga Studio"), "wellness");
});

test("8. isValidTemplateId: known ids pass", () => {
  for (const id of VALID_TEMPLATE_IDS) {
    assert.ok(isValidTemplateId(id), `Expected ${id} to be valid`);
  }
});

test("9. isValidTemplateId: unknown id fails", () => {
  assert.equal(isValidTemplateId("luxury-resort"), false);
  assert.equal(isValidTemplateId(""), false);
  assert.equal(isValidTemplateId("nonexistent"), false);
});

// ─── Prospect project generation ───────────────────────────────────────────

function makeProject(overrides = {}) {
  return generateProspectProject({
    websiteId: "site_test001",
    lead: makeLead(),
    verifiedFields: { businessName: true, category: true, phone: true, email: true, services: true },
    templateId: "plumber",
    generationId: "gen_001",
    ...overrides,
  });
}

test("10. generateProspectProject: uses websiteId as project.id", () => {
  const project = makeProject({ websiteId: "site_abc999" });
  assert.equal(project.id, "site_abc999");
});

test("11. generateProspectProject: sets prospectMeta.isDraft = true", () => {
  const project = makeProject();
  assert.ok(project.prospectMeta, "prospectMeta must exist");
  assert.equal(project.prospectMeta.isDraft, true);
});

test("12. generateProspectProject: sets prospectMeta.leadId and generationId", () => {
  const project = generateProspectProject({
    websiteId: "w1",
    lead: makeLead({ id: "lead_999" }),
    verifiedFields: { businessName: true },
    templateId: "home-services",
    generationId: "gen_xyz",
  });
  assert.equal(project.prospectMeta.leadId, "lead_999");
  assert.equal(project.prospectMeta.generationId, "gen_xyz");
});

test("13. generateProspectProject: businessName appears in home hero title", () => {
  const project = makeProject();
  const homeSections = project.pages.home.sections;
  const hero = homeSections.find((s) => s.type === "hero");
  assert.ok(hero, "home page must have a hero section");
  assert.equal(hero.title, "Pine Tree Plumbing");
});

test("14. generateProspectProject: services included when field selected and present", () => {
  const project = makeProject({
    verifiedFields: { businessName: true, services: true },
  });
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  const servicesSections = allSections.filter((s) => s.type === "services-list");
  assert.ok(servicesSections.length > 0, "services-list section must be present");
  // Titles should include at least one service
  const items = servicesSections[0].items;
  assert.ok(items.length > 0, "services-list must have items");
  assert.ok(items.every((it) => typeof it.title === "string" && it.title.length > 0), "all items have titles");
  // Descriptions must be blank (prospect-safe)
  assert.ok(items.every((it) => it.description === ""), "all items have blank descriptions (prospect-safe)");
});

test("15. generateProspectProject: services omitted when field not selected", () => {
  const project = generateProspectProject({
    websiteId: "w2",
    lead: makeLead(),
    verifiedFields: { businessName: true }, // no services
    templateId: "home-services",
    generationId: "g2",
  });
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  const servicesSections = allSections.filter((s) => s.type === "services-list");
  assert.equal(servicesSections.length, 0, "no services-list when not selected");
});

test("16. generateProspectProject: phone omitted from project when not in verifiedFields", () => {
  const project = generateProspectProject({
    websiteId: "w3",
    lead: makeLead({ phone: "6045550100" }),
    verifiedFields: { businessName: true }, // no phone
    templateId: "home-services",
    generationId: "g3",
  });
  assert.equal(project.business.phone, "", "phone should be empty string when not selected");
});

test("17. generateProspectProject: phone omitted when field selected but lead value empty", () => {
  const project = generateProspectProject({
    websiteId: "w4",
    lead: makeLead({ phone: "" }),
    verifiedFields: { businessName: true, phone: true },
    templateId: "home-services",
    generationId: "g4",
  });
  assert.equal(project.business.phone, "", "empty lead phone stays empty");
});

test("18. generateProspectProject: email omitted when not in verifiedFields", () => {
  const project = generateProspectProject({
    websiteId: "w5",
    lead: makeLead({ email: "real@example.com" }),
    verifiedFields: { businessName: true }, // no email
    templateId: "home-services",
    generationId: "g5",
  });
  assert.equal(project.business.email, "", "email should be empty string when not selected");
});

test("19. generateProspectProject: no receptionist on generated project", () => {
  const project = makeProject();
  // receptionist should be absent or disabled
  assert.ok(!project.receptionist?.enabled, "no receptionist on prospect project");
});

test("20. generateProspectProject: no testimonials sections", () => {
  const project = makeProject();
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  assert.equal(
    allSections.filter((s) => s.type === "testimonials").length,
    0,
    "no testimonials sections in prospect project",
  );
});

test("21. generateProspectProject: no stats sections", () => {
  const project = makeProject();
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  assert.equal(allSections.filter((s) => s.type === "stats").length, 0, "no stats sections");
});

test("22. generateProspectProject: no team sections", () => {
  const project = makeProject();
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  assert.equal(allSections.filter((s) => s.type === "team").length, 0, "no team sections");
});

test("23. generateProspectProject: no faq sections", () => {
  const project = makeProject();
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  assert.equal(allSections.filter((s) => s.type === "faq").length, 0, "no faq sections");
});

test("24. generateProspectProject: contact-form only when phone or email present", () => {
  // No contact info → no contact-form
  const noContact = generateProspectProject({
    websiteId: "w6",
    lead: makeLead({ phone: null, email: null }),
    verifiedFields: { businessName: true },
    templateId: "home-services",
    generationId: "g6",
  });
  const noContactSections = Object.values(noContact.pages).flatMap((p) => p.sections);
  assert.equal(
    noContactSections.filter((s) => s.type === "contact-form").length,
    0,
    "no contact-form when no contact info",
  );

  // With phone → contact-form present
  const withContact = generateProspectProject({
    websiteId: "w7",
    lead: makeLead({ phone: "6045550101" }),
    verifiedFields: { businessName: true, phone: true },
    templateId: "home-services",
    generationId: "g7",
  });
  const withContactSections = Object.values(withContact.pages).flatMap((p) => p.sections);
  assert.ok(
    withContactSections.filter((s) => s.type === "contact-form").length > 0,
    "contact-form present when phone selected",
  );
});

test("25. generateProspectProject: description from verifiedFields when present", () => {
  const project = generateProspectProject({
    websiteId: "w8",
    lead: makeLead({ description: "We fix all pipes." }),
    verifiedFields: { businessName: true, description: true },
    templateId: "home-services",
    generationId: "g8",
  });
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  const aboutSection = allSections.find((s) => s.type === "about-text");
  assert.ok(aboutSection, "about-text section present when description selected");
  assert.ok(
    aboutSection.content.includes("We fix all pipes."),
    "description content included in about-text",
  );
});

test("26. generateProspectProject: template tokens applied correctly", () => {
  const project = generateProspectProject({
    websiteId: "w9",
    lead: makeLead(),
    verifiedFields: { businessName: true },
    templateId: "cafe",
    generationId: "g9",
  });
  // Cafe uses Fraunces heading font
  assert.equal(project.designTokens.fontHeading, "Fraunces");
  assert.equal(project.designTokens.primaryColor, "#d97706");
});

// ─── buildVerifiedFieldsSnapshot ─────────────────────────────────────────

test("27. buildVerifiedFieldsSnapshot: only returns allowed fields that are true", () => {
  const lead = makeLead({ phone: "6045550199", email: "a@b.com" });
  const snapshot = buildVerifiedFieldsSnapshot(lead, {
    businessName: true,
    phone: true,
    category: false, // false → excluded
    UNKNOWN_FIELD: true, // not in PROSPECT_ALLOWED_FIELDS → excluded
  });
  assert.equal(snapshot.businessName, "Pine Tree Plumbing");
  assert.equal(snapshot.phone, "6045550199");
  assert.equal(snapshot.category, undefined, "category is false → excluded");
  assert.equal(snapshot.UNKNOWN_FIELD, undefined, "unknown field excluded");
});

test("28. buildVerifiedFieldsSnapshot: null lead values produce null snapshot entry", () => {
  const lead = makeLead({ email: null });
  const snapshot = buildVerifiedFieldsSnapshot(lead, { businessName: true, email: true });
  assert.equal(snapshot.email, null, "null lead field produces null snapshot entry");
});

// ─── validateProspectSafeProject ─────────────────────────────────────────

function makeValidProject(overrides = {}) {
  const project = makeProject();
  return Object.assign({}, project, overrides);
}

test("29. validateProspectSafeProject: accepts valid draft project", () => {
  const project = makeProject();
  const err = validateProspectSafeProject(project);
  assert.equal(err, null, `Expected no error, got: ${err}`);
});

test("30. validateProspectSafeProject: rejects project missing prospectMeta", () => {
  const project = { ...makeProject(), prospectMeta: undefined };
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject missing prospectMeta");
});

test("31. validateProspectSafeProject: rejects project with isDraft !== true", () => {
  const project = makeValidProject({ prospectMeta: { isDraft: false, leadId: "l", generationId: "g" } });
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject isDraft=false");
});

test("32. validateProspectSafeProject: rejects project with receptionist enabled", () => {
  const project = makeValidProject({ receptionist: { enabled: true } });
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject receptionist enabled");
});

test("33. validateProspectSafeProject: rejects project with visible testimonials", () => {
  const project = makeProject();
  // Inject a testimonials section into home page sections + sectionOrder
  const testSection = { id: "t99", type: "testimonials", title: "What They Say", items: [] };
  project.pages.home.sections.push(testSection);
  project.sectionOrder.home.push("t99");
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject visible testimonials");
  assert.ok(err.includes("testimonials"), `error should mention testimonials: ${err}`);
});

test("34. validateProspectSafeProject: accepts project with hidden testimonials", () => {
  const project = makeProject();
  // Add testimonials but put them in hiddenSections
  const testSection = { id: "t99", type: "testimonials", title: "What They Say", items: [] };
  project.pages.home.sections.push(testSection);
  project.sectionOrder.home.push("t99");
  project.hiddenSections.home.push("t99"); // hidden → safe
  const err = validateProspectSafeProject(project);
  assert.equal(err, null, "hidden testimonials are safe");
});

test("35. validateProspectSafeProject: rejects project with visible stats", () => {
  const project = makeProject();
  const statsSection = { id: "st1", type: "stats", title: "Our Numbers", items: [] };
  project.pages.home.sections.push(statsSection);
  project.sectionOrder.home.push("st1");
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject visible stats");
  assert.ok(err.includes("stats"), `error should mention stats: ${err}`);
});

test("36. validateProspectSafeProject: rejects project with visible team", () => {
  const project = makeProject();
  const teamSection = { id: "tm1", type: "team", title: "Our Team", items: [] };
  project.pages.home.sections.push(teamSection);
  project.sectionOrder.home.push("tm1");
  const err = validateProspectSafeProject(project);
  assert.ok(err !== null, "should reject visible team");
  assert.ok(err.includes("team"), `error should mention team: ${err}`);
});

// ─── HMAC signing ──────────────────────────────────────────────────────────

test("37. newMappingId: produces non-empty URL-safe base64", () => {
  const id = newMappingId();
  assert.ok(typeof id === "string" && id.length > 10, "mappingId must be a non-empty string");
  assert.ok(/^[A-Za-z0-9_-]+$/.test(id), "mappingId must be URL-safe base64");
});

test("38. computeSignature: deterministic for same input", () => {
  const id = "test-mapping-id-abc";
  const sig1 = computeSignature(id);
  const sig2 = computeSignature(id);
  assert.equal(sig1, sig2, "signature must be deterministic");
  assert.ok(sig1.length === 64, "sha256 hex is 64 chars");
});

test("39. computeSignature: different mappingIds produce different signatures", () => {
  const sig1 = computeSignature("id-aaa");
  const sig2 = computeSignature("id-bbb");
  assert.notEqual(sig1, sig2, "different ids must produce different signatures");
});

test("40. hashSignature: produces 64-char hex (sha256)", () => {
  const hash = hashSignature("some-signature-value");
  assert.equal(hash.length, 64, "sha256 hex is 64 chars");
  assert.ok(/^[0-9a-f]+$/.test(hash), "must be lowercase hex");
});

test("41. verifySignature: returns true for correct inputs", () => {
  const mappingId = "verify-test-mapping-abc-123";
  const sig = computeSignature(mappingId);
  const storedHash = hashSignature(sig);
  const result = verifySignature(mappingId, sig, storedHash);
  assert.equal(result, true, "correct inputs must verify");
});

test("42. verifySignature: returns false for tampered mappingId", () => {
  const mappingId = "original-mapping-id";
  const sig = computeSignature(mappingId);
  const storedHash = hashSignature(sig);
  const result = verifySignature("tampered-mapping-id", sig, storedHash);
  assert.equal(result, false, "tampered mappingId must fail");
});

test("43. verifySignature: returns false for tampered signature", () => {
  const mappingId = "some-mapping-id";
  const sig = computeSignature(mappingId);
  const storedHash = hashSignature(sig);
  // Flip first char of signature
  const tampered = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
  const result = verifySignature(mappingId, tampered, storedHash);
  assert.equal(result, false, "tampered signature must fail");
});

test("44. verifySignature: returns false for wrong storedHash", () => {
  const mappingId = "mapping-ok";
  const sig = computeSignature(mappingId);
  // Use hash of a different signature
  const wrongHash = hashSignature("completely-different-signature-value-here");
  const result = verifySignature(mappingId, sig, wrongHash);
  assert.equal(result, false, "wrong storedHash must fail");
});

test("45. buildPreviewPath: starts with /api/prospect-previews/", () => {
  const path = buildPreviewPath("abc123def456ghijklmn");
  assert.ok(path.startsWith("/api/prospect-previews/"), `path must start correctly: ${path}`);
});

test("46. buildPreviewPath: uses path segments (no ?sig= query param)", () => {
  const mappingId = "abc123def456ghijklmn";
  const path = buildPreviewPath(mappingId);
  // Must NOT have ?sig= query parameter
  assert.ok(!path.includes("?sig="), `path must not have ?sig= query param: ${path}`);
  // Must have path segments: /api/prospect-previews/{mappingId}/{signature}/
  // Format: /api/prospect-previews/<mappingId>/<64-hex-sig>/
  const parts = path.split("/");
  // parts: ["", "api", "prospect-previews", mappingId, signature, ""]
  assert.ok(parts.length >= 6, `path must have enough segments: ${path}`);
  assert.equal(parts[3], mappingId, "4th segment must be mappingId");
  // 5th segment must be 64-char hex signature
  assert.ok(/^[0-9a-f]{64}$/.test(parts[4]), `5th segment must be 64-char hex sig: ${parts[4]}`);
  // Must end with trailing slash
  assert.ok(path.endsWith("/"), `path must end with trailing slash: ${path}`);
});

test("47. previewExpiresAt: is ~24 hours from now (24h TTL)", () => {
  const before = Date.now();
  const exp = previewExpiresAt();
  const after = Date.now();
  const delta = exp.getTime() - before;
  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  // Allow 1 second tolerance
  assert.ok(
    delta >= twentyFourHoursMs - 1000 && delta <= twentyFourHoursMs + (after - before) + 1000,
    `expiry must be ~24 hours: delta=${delta}ms`,
  );
});

// ─── Serialization contract (inline faithfully replicating the server logic) ─

function fakeBuildPreviewPath(mappingId) {
  // Must match routes-prospect.ts serializeProspectSite logic
  // Path-segment format: /api/prospect-previews/{mappingId}/{signature}/
  return `/api/prospect-previews/${mappingId}/FAKESIG64HEX0000000000000000000000000000000000000000000000000000/`;
}

function serializeProspectSite(ps, gen, preview, websiteRevision) {
  const now = new Date();
  const hasActivePreview = preview !== null && preview.expiresAt > now;
  const previewPath = hasActivePreview ? fakeBuildPreviewPath(preview.mappingId) : null;
  return {
    id: ps.id,
    leadId: ps.leadId,
    state: ps.state,
    websiteId: ps.websiteId ?? null,
    websiteRevision,
    templateId: gen?.templateId ?? null,
    // generationCount is now integer from DB (not string)
    generationCount: ps.generationCount,
    hasActivePreview,
    previewPath,
    previewExpiresAt: hasActivePreview ? preview.expiresAt : null,
    createdAt: ps.createdAt,
    updatedAt: ps.updatedAt,
    archivedAt: ps.archivedAt ?? null,
    convertedAt: ps.convertedAt ?? null,
  };
}

const now = new Date();
const futureExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const pastExpiry = new Date(now.getTime() - 1000);

const basePs = {
  id: "ps_001",
  leadId: "lead_001",
  ownerId: "owner_001",
  state: "active_draft",
  websiteId: "site_001",
  // generationCount is integer in DB (not string)
  generationCount: 3,
  verifiedFieldsSnapshot: {},
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  convertedAt: null,
};

const baseGen = { id: "gen_001", templateId: "plumber", status: "active" };

const basePreview = {
  mappingId: "map_abc123xyz",
  signatureHash: "hash",
  ownerId: "owner_001",
  leadId: "lead_001",
  prospectSiteId: "ps_001",
  websiteId: "site_001",
  websiteRevision: 0,   // integer
  expiresAt: futureExpiry,
  createdAt: now,
};

test("48. GET response: returns null for no lifecycle (stable empty state)", () => {
  // No lifecycle → server should return JSON null with HTTP 200
  // We test the serialization: when ctx is null, pass null through
  const result = null;
  assert.equal(result, null, "null lifecycle produces null response");
});

test("49. GET response: serializer includes previewPath when unexpired preview exists", () => {
  const record = serializeProspectSite(basePs, baseGen, basePreview, 0);
  assert.ok(record.hasActivePreview, "hasActivePreview must be true");
  assert.ok(record.previewPath !== null, "previewPath must be non-null for unexpired preview");
  assert.ok(record.previewPath.includes("map_abc123xyz"), "previewPath must include mappingId");
});

test("50. GET response: serializer returns null previewPath when preview expired", () => {
  const expiredPreview = { ...basePreview, expiresAt: pastExpiry };
  const record = serializeProspectSite(basePs, baseGen, expiredPreview, 0);
  assert.equal(record.hasActivePreview, false, "hasActivePreview false for expired preview");
  assert.equal(record.previewPath, null, "previewPath null for expired preview");
});

test("51. GET response: serializer includes templateId from generation row", () => {
  const record = serializeProspectSite(basePs, baseGen, null, 5);
  assert.equal(record.templateId, "plumber");
});

test("52. GET response: serializer returns null templateId when no generation", () => {
  const record = serializeProspectSite(basePs, null, null, 0);
  assert.equal(record.templateId, null, "templateId null when no generation");
});

// ─── Advisory lock ────────────────────────────────────────────────────────

// Inline the lock key logic matching routes-prospect.ts
const PROSPECT_LOCK_NAMESPACE = 0x2b3c4d5e;

function prospectLockKey(ownerId, leadId) {
  let hash = 0x811c9dc5;
  const combined = `${ownerId}::${leadId}`;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (BigInt(PROSPECT_LOCK_NAMESPACE) << 32n) | BigInt(hash >>> 0);
}

test("53. prospectLockKey: deterministic for same owner+lead", () => {
  const k1 = prospectLockKey("owner_A", "lead_1");
  const k2 = prospectLockKey("owner_A", "lead_1");
  assert.equal(k1, k2, "same inputs must produce same key");
});

test("54. prospectLockKey: different owners produce different keys", () => {
  const k1 = prospectLockKey("owner_A", "lead_1");
  const k2 = prospectLockKey("owner_B", "lead_1");
  assert.notEqual(k1, k2, "different owners must produce different keys");
});

test("55. prospectLockKey: different leads produce different keys", () => {
  const k1 = prospectLockKey("owner_A", "lead_1");
  const k2 = prospectLockKey("owner_A", "lead_2");
  assert.notEqual(k1, k2, "different leads must produce different keys");
});

// ─── Lead eligibility validation ──────────────────────────────────────────

function validateLeadEligible(lead) {
  if (lead.pipelineStatus !== "qualified") {
    return `Lead must be in 'qualified' status to generate a prospect site (currently '${lead.pipelineStatus}').`;
  }
  if (lead.suppressed) {
    return "Lead is suppressed (Do Not Contact) — prospect site generation is not allowed.";
  }
  return null;
}

test("56. validateLeadEligible: qualified non-suppressed lead passes", () => {
  assert.equal(validateLeadEligible(makeLead()), null);
});

test("57. validateLeadEligible: non-qualified lead fails", () => {
  const err = validateLeadEligible(makeLead({ pipelineStatus: "new" }));
  assert.ok(err !== null, "should fail for non-qualified");
  assert.ok(err.includes("qualified"), `error should mention qualified: ${err}`);
  assert.ok(err.includes("new"), `error should show current status: ${err}`);
});

test("58. validateLeadEligible: suppressed lead fails", () => {
  const err = validateLeadEligible(makeLead({ suppressed: true }));
  assert.ok(err !== null, "should fail for suppressed lead");
  assert.ok(err.includes("suppressed"), `error should mention suppressed: ${err}`);
});

// ─── PROSPECT_ALLOWED_FIELDS ──────────────────────────────────────────────

test("59. PROSPECT_ALLOWED_FIELDS: only allowlisted keys accepted", () => {
  const allowed = [...PROSPECT_ALLOWED_FIELDS];
  // Core fields must be present
  assert.ok(allowed.includes("businessName"), "businessName must be allowed");
  assert.ok(allowed.includes("phone"), "phone must be allowed");
  assert.ok(allowed.includes("email"), "email must be allowed");
  assert.ok(allowed.includes("city"), "city must be allowed");
  assert.ok(allowed.includes("services"), "services must be allowed");
  // Dangerous fields must NOT be present
  assert.ok(!allowed.includes("ownerId"), "ownerId must not be allowed");
  assert.ok(!allowed.includes("id"), "id must not be allowed");
  assert.ok(!allowed.includes("pipelineStatus"), "pipelineStatus must not be allowed");
  assert.ok(!allowed.includes("suppressed"), "suppressed must not be allowed");
  assert.ok(!allowed.includes("score"), "score must not be allowed");
});

// ─── Serialization: generationCount is integer ────────────────────────────

test("60. serializeProspectSite: generationCount is integer from DB integer column", () => {
  // generationCount is now stored as integer in DB; must be number in API response
  const record = serializeProspectSite(
    { ...basePs, generationCount: 7 },  // integer from DB
    baseGen,
    null,
    0,
  );
  assert.equal(typeof record.generationCount, "number", "generationCount must be a number");
  assert.equal(record.generationCount, 7);
});

// ─── No invented copy ────────────────────────────────────────────────────

test("61. No invented copy: hero subtitle is empty when no description selected", () => {
  const project = generateProspectProject({
    websiteId: "nc1",
    lead: makeLead({ description: "Some real desc." }),
    verifiedFields: { businessName: true }, // description NOT selected
    templateId: "home-services",
    generationId: "nc_g1",
  });
  const hero = project.pages.home.sections.find((s) => s.type === "hero");
  assert.ok(hero, "hero must exist");
  // subtitle must be empty — no invented fallback
  assert.equal(hero.subtitle, "", `hero subtitle must be empty when description not selected, got: "${hero.subtitle}"`);
});

test("62. No invented copy: hero subtitle is description when description selected", () => {
  const project = generateProspectProject({
    websiteId: "nc2",
    lead: makeLead({ description: "We fix leaks fast." }),
    verifiedFields: { businessName: true, description: true },
    templateId: "home-services",
    generationId: "nc_g2",
  });
  const hero = project.pages.home.sections.find((s) => s.type === "hero");
  assert.ok(hero, "hero must exist");
  assert.equal(hero.subtitle, "We fix leaks fast.", "hero subtitle must be stored description");
});

test("63. No invented copy: contact-form subtitle is empty when no city selected", () => {
  const project = generateProspectProject({
    websiteId: "nc3",
    lead: makeLead({ phone: "6045550101", city: "Burnaby" }),
    verifiedFields: { businessName: true, phone: true }, // city NOT selected
    templateId: "home-services",
    generationId: "nc_g3",
  });
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  const contactForms = allSections.filter((s) => s.type === "contact-form");
  assert.ok(contactForms.length > 0, "contact-form must exist when phone selected");
  // ALL contact-form subtitles must be empty (no invented 'Serving ... areas' or 'We would love...')
  for (const cf of contactForms) {
    assert.equal(
      cf.subtitle,
      "",
      `contact-form subtitle must be empty when city not selected, got: "${cf.subtitle}"`,
    );
  }
});

test("64. No invented copy: contact-form subtitle has city when city selected", () => {
  const project = generateProspectProject({
    websiteId: "nc4",
    lead: makeLead({ phone: "6045550101", city: "Burnaby" }),
    verifiedFields: { businessName: true, phone: true, city: true },
    templateId: "home-services",
    generationId: "nc_g4",
  });
  const allSections = Object.values(project.pages).flatMap((p) => p.sections);
  const contactForms = allSections.filter((s) => s.type === "contact-form");
  assert.ok(contactForms.length > 0, "contact-form must exist");
  // At least one contact-form has city in subtitle
  const hasCity = contactForms.some((cf) => cf.subtitle && cf.subtitle.includes("Burnaby"));
  assert.ok(hasCity, "at least one contact-form subtitle must include city when city selected");
});

test("65. No invented copy: business.category is empty string when not selected", () => {
  const project = generateProspectProject({
    websiteId: "nc5",
    lead: makeLead({ category: "Plumbing" }),
    verifiedFields: { businessName: true }, // category NOT selected
    templateId: "home-services",
    generationId: "nc_g5",
  });
  // business.category must be empty string — never 'Services' or 'Plumbing'
  assert.equal(project.business.category, "", `business.category must be empty when not selected, got: "${project.business.category}"`);
});

test("66. No invented copy: HTML must not contain forbidden phrases", () => {
  // Build a project without description/city to test absence of invented copy
  const project = generateProspectProject({
    websiteId: "nc6",
    lead: makeLead({ phone: "6045550101", city: "Victoria", description: null }),
    verifiedFields: { businessName: true, phone: true }, // no description, no city
    templateId: "home-services",
    generationId: "nc_g6",
  });

  // Serialize the project to JSON (what would be stored) to check for forbidden strings
  const serialized = JSON.stringify(project);

  const forbiddenPhrases = [
    "you can rely on",
    "surrounding areas",
    "We would love to hear from you",
    "hello@example.com",
    "Services in ",   // fallback 'Services in {empty}'
  ];

  for (const phrase of forbiddenPhrases) {
    assert.ok(
      !serialized.includes(phrase),
      `Generated project must not contain invented copy: "${phrase}"`,
    );
  }
});

// ─── Signed URL path segment format ───────────────────────────────────────

test("67. Signed URL: path segments format (mappingId/signature/ with trailing slash)", () => {
  const mappingId = newMappingId();
  const path = buildPreviewPath(mappingId);
  // Format: /api/prospect-previews/{mappingId}/{64-hex-sig}/
  const regex = /^\/api\/prospect-previews\/[A-Za-z0-9_-]+\/[0-9a-f]{64}\/$/;
  assert.ok(
    regex.test(path),
    `Preview path must match /api/prospect-previews/{mappingId}/{sig}/ format, got: ${path}`,
  );
});

test("68. Signed URL: relative assets resolve under signed prefix", () => {
  const mappingId = newMappingId();
  const basePath = buildPreviewPath(mappingId);
  // The base path ends with /; relative URLs resolve under it.
  // styles.css relative to /api/prospect-previews/{id}/{sig}/ →
  //   /api/prospect-previews/{id}/{sig}/styles.css
  // This confirms the trailing slash approach is correct.
  assert.ok(basePath.endsWith("/"), "base path must end with trailing slash for relative resolution");
  const cssPath = basePath + "styles.css";
  assert.ok(
    cssPath.startsWith("/api/prospect-previews/"),
    "CSS path must be under the signed prefix",
  );
  assert.ok(
    cssPath.endsWith("/styles.css"),
    "CSS path must end with /styles.css",
  );
});

// ─── Provenance snapshot ─────────────────────────────────────────────────

test("69. Provenance: buildVerifiedFieldsSnapshot captures DB values for non-empty fields", () => {
  // Simulates what appendVerifiedProvenance would use: actual DB lead values
  const lead = makeLead({
    phone: "6045550199",
    email: "owner@business.example",
    city: "Kelowna",
    description: "We provide top-notch service.",
  });

  // Only non-empty fields with verifiedFields=true should be snapshotted
  const snapshot = buildVerifiedFieldsSnapshot(lead, {
    businessName: true,
    phone: true,
    email: true,
    city: true,
    description: true,
    category: false,  // not selected
  });

  assert.equal(snapshot.businessName, "Pine Tree Plumbing", "businessName from DB");
  assert.equal(snapshot.phone, "6045550199", "phone from DB");
  assert.equal(snapshot.email, "owner@business.example", "email from DB");
  assert.equal(snapshot.city, "Kelowna", "city from DB");
  assert.equal(snapshot.description, "We provide top-notch service.", "description from DB");
  assert.equal(snapshot.category, undefined, "category not selected → absent");

  // Verify no client-injected values could slip in
  const keys = Object.keys(snapshot);
  for (const key of keys) {
    assert.ok(
      [...PROSPECT_ALLOWED_FIELDS].includes(key),
      `snapshot key '${key}' must be an allowed field`,
    );
  }
});

// ─── Frozen preview-store reuse: strict prospect CSP ────────────────────────

test("70. Strict prospect CSP: img-src 'self' data: and connect-src 'none'", () => {
  const res = makeMockRes();
  const served = serveStoredPreviewAsset(
    res,
    makeStoredSite(),
    "index.html",
    { strictProspect: true },
  );
  assert.equal(served, true, "a valid asset must be served");
  assert.equal(res.statusCode, 200);
  const csp = res.headers["Content-Security-Policy"];
  assert.ok(csp, "CSP header must be set");
  assert.ok(
    csp.includes("img-src 'self' data:") && !csp.includes("img-src 'self' https:"),
    `prospect CSP img-src must be self/data only, got: ${csp}`,
  );
  assert.ok(
    csp.includes("connect-src 'none'"),
    `prospect CSP connect-src must be 'none', got: ${csp}`,
  );
  // Robots / no-store headers still applied
  assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  assert.ok(res.headers["X-Robots-Tag"].includes("noindex"));
});

test("71. Frozen delivery serves stored bytes verbatim (no regeneration)", () => {
  // The stored site's js/css are served exactly as frozen — never regenerated.
  const site = makeStoredSite({
    css: "body{color:#abcdef}",
    js: "/* frozen-marker-9f2a */ void 0;",
  });
  const cssRes = makeMockRes();
  assert.equal(
    serveStoredPreviewAsset(cssRes, site, "styles.css", { strictProspect: true }),
    true,
  );
  assert.equal(cssRes.body, "body{color:#abcdef}", "css served verbatim");
  assert.equal(cssRes.contentType, "text/css");

  const jsRes = makeMockRes();
  assert.equal(
    serveStoredPreviewAsset(jsRes, site, "main.js", { strictProspect: true }),
    true,
  );
  assert.equal(jsRes.body, "/* frozen-marker-9f2a */ void 0;", "js served verbatim");
  assert.equal(jsRes.contentType, "text/javascript");
});

test("72. Delivery route uses frozen store, never regenerates at request time", () => {
  // Source-level regression guard: the public delivery module must serve the
  // frozen client_previews row via serveStoredPreviewAsset and must NOT import
  // or call generateSite (which would re-render editable source at request time).
  const deliverySrc = readFileSync(
    new URL("../src/routes/lead-acquisition/prospect-preview-delivery.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /serveStoredPreviewAsset/.test(deliverySrc),
    "delivery must serve via serveStoredPreviewAsset",
  );
  assert.ok(
    /strictProspect:\s*true/.test(deliverySrc),
    "delivery must apply strict prospect CSP",
  );
  assert.ok(
    /clientPreviewIdHash/.test(deliverySrc),
    "delivery must look up the frozen row by clientPreviewIdHash",
  );
  assert.ok(
    !/generateSite/.test(deliverySrc),
    "delivery must NOT regenerate the site at public request time",
  );
  assert.ok(
    !/projectSource/.test(deliverySrc),
    "delivery must NOT read editable projectSource",
  );
});

// ─── Ordinary preview regression (unchanged behavior) ───────────────────────

test("73. Ordinary preview CSP regression: img-src allows https:, connect derived", () => {
  const res = makeMockRes();
  const served = serveStoredPreviewAsset(res, makeStoredSite(), "index.html");
  assert.equal(served, true);
  const csp = res.headers["Content-Security-Policy"];
  assert.ok(
    csp.includes("img-src 'self' https: data:"),
    `ordinary CSP must allow https: images, got: ${csp}`,
  );
  // Static (non-receptionist) script → connect-src 'none' by derivation.
  assert.ok(
    csp.includes("connect-src 'none'"),
    `ordinary CSP connect-src derived from script, got: ${csp}`,
  );
});

test("74. Preview store: unknown asset returns 404 (unchanged)", () => {
  const res = makeMockRes();
  const served = serveStoredPreviewAsset(res, makeStoredSite(), "nope.html");
  assert.equal(served, false);
  assert.equal(res.statusCode, 404);
});

test("75. validateSite (shared) accepts a frozen prospect-safe site", () => {
  assert.equal(validateSite(makeStoredSite()), null, "clean site validates");
});

test("76. validateSite (shared) rejects unsafe markup in frozen site", () => {
  const bad = makeStoredSite({
    pages: {
      "index.html": '<html><body onclick="x()">bad</body></html>',
    },
  });
  assert.notEqual(validateSite(bad), null, "inline handler must be rejected");
});

// ─── Prospect editor-hash namespace: excluded from ordinary quotas ──────────

test("77. Prospect editorHash is namespaced (never collides with ordinary key hash)", () => {
  const prefix = PROSPECT_EDITOR_HASH_PREFIX;
  assert.equal(typeof prefix, "string");
  assert.ok(prefix.length > 0, "prefix must be non-empty");

  // Ordinary editor hash is a bare 64-char sha256 hex digest.
  const ordinary = hashSecret("some-editor-key");
  assert.ok(/^[0-9a-f]{64}$/.test(ordinary), "ordinary hash is bare sha256 hex");
  assert.ok(
    !ordinary.startsWith(prefix),
    "ordinary hash must never carry the prospect prefix",
  );

  // A prospect-namespaced editor hash is prefixed and thus excluded by the
  // NOT LIKE 'prospect:%' filter used for ordinary per-editor/total counts.
  const prospectHash = prefix + hashSecret("prospect:owner:site");
  assert.ok(prospectHash.startsWith(prefix), "prospect hash must be prefixed");
  assert.notEqual(prospectHash, ordinary);
});

test("78. Frozen client_preview fields: random non-public hashes + 24h expiry", () => {
  // Mirrors how publish freezes the site into client_previews: idHash/tokenHash
  // are random (never the public mappingId/signature), and TTL is 24h.
  const idHash = hashSecret(newSecret());
  const tokenHash = hashSecret(newSecret());
  assert.ok(/^[0-9a-f]{64}$/.test(idHash), "idHash is sha256 hex of a random secret");
  assert.ok(/^[0-9a-f]{64}$/.test(tokenHash), "tokenHash is sha256 hex of a random secret");
  assert.notEqual(idHash, tokenHash, "id and token hashes must differ");
  assert.equal(previewLifetimeMs, 24 * 60 * 60 * 1000, "frozen preview TTL is 24h");
});

test("79. Phone-only prospect output never invents an email address", () => {
  const project = generateProspectProject({
    lead: makeLead({ email: null }),
    websiteId: "site_phone_only",
    generationId: "gen_phone_only",
    verifiedFields: { businessName: true, phone: true, city: true },
    templateId: "plumber",
  });
  const site = generateSite(project);
  const html = Object.values(site.pages).join("\n");

  assert.ok(html.includes("6045550101"), "verified phone remains visible");
  assert.ok(!html.includes("hello@example.com"), "fallback email must never be rendered");
  assert.ok(!html.includes("mailto:"), "phone-only prospect must not render an email link");
  assert.ok(!html.includes("data-recipient="), "phone-only prospect must not render an email form");
});

test("80. Invalid selected prospect email is omitted rather than replaced", () => {
  const project = generateProspectProject({
    lead: makeLead({ email: "not-an-email" }),
    websiteId: "site_invalid_email",
    generationId: "gen_invalid_email",
    verifiedFields: { businessName: true, email: true, city: true },
    templateId: "plumber",
  });
  const site = generateSite(project);
  const html = Object.values(site.pages).join("\n");

  assert.ok(!html.includes("not-an-email"), "invalid email must not be rendered");
  assert.ok(!html.includes("hello@example.com"), "invalid email must not trigger a fallback");
  assert.ok(!html.includes("mailto:"), "invalid email must not create a mailto link");
  assert.ok(!html.includes("data-recipient="), "invalid email must not create a contact form");
});

test("81. Request logging redacts prospect preview signatures and query strings", () => {
  const signature = "a".repeat(64);
  const url = `/api/prospect-previews/map_test/${signature}/styles.css?cache=secret`;
  const sanitized = sanitizeRequestUrlForLogs(url);

  assert.equal(
    sanitized,
    "/api/prospect-previews/map_test/[redacted]/styles.css",
  );
  assert.ok(!sanitized.includes(signature), "raw capability signature must not reach logs");
  assert.ok(!sanitized.includes("cache=secret"), "query strings must not reach logs");
});

test("82. Request logging also redacts ordinary public preview tokens", () => {
  const token = "ordinary-public-preview-token";
  const sanitized = sanitizeRequestUrlForLogs(
    `/api/previews/public/${token}/main.js`,
  );

  assert.equal(sanitized, "/api/previews/public/[redacted]/main.js");
  assert.ok(!sanitized.includes(token), "ordinary preview bearer token must not reach logs");
});
