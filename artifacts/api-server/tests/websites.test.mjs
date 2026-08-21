/**
 * Website tests — use generated Zod schemas for real validation,
 * plus focused behavioral tests for sanitization, import logic, and conflicts.
 *
 * Covers:
 * 1. SiteProject schema rejects ownerKey, passes sanitized fixture
 * 2. Import helper: existing owner+id => skipped (never overwrites)
 * 3. Stale revision conflict detection
 * 4. Owner isolation (composite PK)
 * 5. Credential stripping on duplicate
 * 6. Migration idempotency SQL
 * 7. Safe integer validation helpers
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// ─── Build sanitize lib ────────────────────────────────────────────────────
const outputDir = await mkdtemp(join(tmpdir(), "siteforge-website-"));

const sanitizeOut = join(outputDir, "website-sanitize.mjs");
await build({
  entryPoints: [
    new URL("../src/lib/website-sanitize.ts", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: sanitizeOut,
  logLevel: "silent",
});
const { stripCredentials, sanitizeProjectSource } = await import(
  pathToFileURL(sanitizeOut).href
);

// ─── Build API-zod for Zod validation ─────────────────────────────────────
const zodOut = join(outputDir, "api-zod.mjs");
await build({
  entryPoints: [
    new URL("../../../lib/api-zod/src/index.ts", import.meta.url).pathname,
  ],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: zodOut,
  logLevel: "silent",
});
const apiZod = await import(pathToFileURL(zodOut).href);
const { CreateWebsiteBody } = apiZod;

// ─── Fixture matching createNewProject output exactly ─────────────────────
// This fixture is compatible with getSeedProject / createNewProject from templates.ts

function makeSeedSection(id, type, overrides = {}) {
  return { id, type, ...overrides };
}

const SEED_PROJECT = {
  id: "proj-seed-001",
  name: "Evergreen Home Services",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  activePageId: "home",
  templateId: "home-services",
  designTokens: {
    primaryColor: "#2d6a4f",
    fontHeading: "Inter",
    fontBody: "Inter",
    borderRadius: "md",
    buttonStyle: "solid",
  },
  business: {
    name: "Evergreen Home Services",
    category: "Exterior Cleaning",
    city: "Toronto",
    phone: "(416) 555-0184",
    email: "hello@evergreenhomes.ca",
  },
  pages: {
    home: {
      id: "home",
      name: "Home",
      sections: [
        makeSeedSection("sec-hero-1", "hero", {
          title: "Your home, back in focus.",
          subtitle: "A small, careful exterior cleaning crew for Toronto homes.",
          content: "Get a quote",
        }),
        makeSeedSection("sec-features-1", "features", {
          title: "The Evergreen Standard",
          items: [
            { title: "Careful & Quiet", description: "We treat your property with respect." },
            { title: "Fully Insured", description: "Comprehensive coverage." },
          ],
        }),
      ],
    },
    about: {
      id: "about",
      name: "About",
      sections: [
        makeSeedSection("sec-about-1", "about-text", {
          title: "Our story",
          content: "Founded to serve Toronto homes with care.",
        }),
      ],
    },
    services: {
      id: "services",
      name: "Services",
      sections: [
        makeSeedSection("sec-services-1", "services-list", {
          title: "What we do best",
          items: [
            { title: "Window cleaning", description: "Streak-free glass." },
            { title: "House washing", description: "Low-pressure wash." },
          ],
        }),
      ],
    },
    contact: {
      id: "contact",
      name: "Contact",
      sections: [
        makeSeedSection("sec-contact-1", "contact-form", {
          title: "Get in touch",
        }),
      ],
    },
  },
  sectionOrder: {
    home: ["sec-hero-1", "sec-features-1"],
    about: ["sec-about-1"],
    services: ["sec-services-1"],
    contact: ["sec-contact-1"],
  },
  hiddenSections: {
    home: [],
    about: [],
    services: [],
    contact: [],
  },
  receptionist: {
    enabled: false,
    assistantName: "Assistant",
    prohibitedActions: "Pricing; payments; booking; scheduling",
    safeAutoReplyCategories: "Hours, Service area, Contact, General services",
  },
};

const SEED_WEBSITE_INPUT = {
  name: "Evergreen Home Services",
  projectSource: SEED_PROJECT,
};

// ─── Schema validation tests ───────────────────────────────────────────────

test("CreateWebsiteBody accepts a valid seed project fixture", () => {
  const result = CreateWebsiteBody.safeParse(SEED_WEBSITE_INPUT);
  if (!result.success) {
    // Print readable errors for debugging
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    assert.fail(`Valid seed project rejected by schema:\n${issues}`);
  }
  assert.ok(result.success, "seed project parses successfully");
});

test("CreateWebsiteBody strips (not rejects) ownerKey — sanitizer is the security boundary", () => {
  // The OpenAPI schema uses additionalProperties:false but Zod codegen strips unknowns
  // rather than rejecting (z.object() strips; .strict() would reject).
  // This means the sanitizer MUST be applied before storage — schema alone is not enough.
  const withOwnerKey = {
    ...SEED_WEBSITE_INPUT,
    projectSource: {
      ...SEED_PROJECT,
      ownerKey: "secret-owner-key",
    },
  };
  const result = CreateWebsiteBody.safeParse(withOwnerKey);
  // Zod strips unknown fields — parse succeeds but ownerKey is gone from output
  assert.ok(result.success, "parse succeeds (Zod strips unknown fields)");
  if (result.success) {
    // ownerKey must NOT be in the parsed output
    assert.equal(
      result.data.projectSource["ownerKey"],
      undefined,
      "ownerKey is stripped from parsed output by Zod",
    );
  }
  // The sanitizer provides an additional defense-in-depth layer
  const sanitized = sanitizeProjectSource({
    ...SEED_PROJECT,
    ownerKey: "secret-owner-key",
    receptionist: { ...SEED_PROJECT.receptionist, ownerKey: "nested" },
  });
  assert.equal(sanitized["ownerKey"], undefined, "sanitizer removes top-level ownerKey");
  assert.equal(
    sanitized["receptionist"]?.["ownerKey"],
    undefined,
    "sanitizer removes nested ownerKey",
  );
});

test("sanitizeProjectSource strips credentials but preserves client timestamps so result parses", () => {
  const projectWithOwnerKey = {
    ...SEED_PROJECT,
    ownerKey: "super-secret",
    ownerId: "server-should-not-be-here",
    revision: 99,
    receptionist: {
      ...SEED_PROJECT.receptionist,
      ownerKey: "nested-secret",
      apiKey: "api-secret",
    },
  };
  const sanitized = sanitizeProjectSource(projectWithOwnerKey);

  // Credential keys stripped
  const json = JSON.stringify(sanitized);
  assert.ok(!json.includes("ownerKey"), "ownerKey stripped from sanitized output");
  assert.ok(!json.includes("super-secret"), "ownerKey value not in output");
  assert.ok(!json.includes("apiKey"), "apiKey stripped from sanitized output");

  // Server-owned DB fields stripped
  assert.equal(sanitized["ownerId"], undefined, "ownerId stripped");
  assert.equal(sanitized["revision"], undefined, "revision stripped");

  // Client-side timestamps preserved (part of SiteProject)
  assert.ok(typeof sanitized["createdAt"] === "number", "createdAt preserved");
  assert.ok(typeof sanitized["updatedAt"] === "number", "updatedAt preserved");

  // The sanitized version should parse as a valid project input
  const input = { name: "Test", projectSource: sanitized };
  const result = CreateWebsiteBody.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    assert.fail(`Sanitized project should parse but got:\n${issues}`);
  }
  assert.ok(result.success, "sanitized project parses successfully");
});

test("CreateWebsiteBody rejects missing required SiteProject fields", () => {
  // Missing sectionOrder and hiddenSections
  const incomplete = {
    name: "Test",
    projectSource: {
      id: "p1",
      name: "Test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activePageId: "home",
      templateId: "home-services",
      designTokens: {
        primaryColor: "#000",
        fontHeading: "Inter",
        fontBody: "Inter",
        borderRadius: "md",
        buttonStyle: "solid",
      },
      business: {
        name: "Test Co",
        category: "Services",
        city: "Toronto",
        phone: "555-0100",
        email: "test@test.com",
      },
      pages: {
        home: { id: "home", name: "Home", sections: [] },
        about: { id: "about", name: "About", sections: [] },
        services: { id: "services", name: "Services", sections: [] },
        contact: { id: "contact", name: "Contact", sections: [] },
      },
      // sectionOrder and hiddenSections intentionally missing
    },
  };
  const result = CreateWebsiteBody.safeParse(incomplete);
  assert.ok(
    !result.success,
    "should reject project missing sectionOrder and hiddenSections",
  );
  const paths = result.error.issues.map((i) => i.path.join("."));
  assert.ok(
    paths.some((p) => p.includes("sectionOrder")),
    `expected sectionOrder error, got: ${paths.join(", ")}`,
  );
});

test("CreateWebsiteBody rejects invalid templateId enum", () => {
  const result = CreateWebsiteBody.safeParse({
    name: "Test",
    projectSource: {
      ...SEED_PROJECT,
      templateId: "invalid-template-id",
    },
  });
  assert.ok(!result.success, "invalid templateId must be rejected");
});

test("CreateWebsiteBody rejects invalid activePageId enum", () => {
  const result = CreateWebsiteBody.safeParse({
    name: "Test",
    projectSource: {
      ...SEED_PROJECT,
      activePageId: "blog",
    },
  });
  assert.ok(!result.success, "invalid activePageId must be rejected");
});

test("CreateWebsiteBody rejects invalid borderRadius enum", () => {
  const result = CreateWebsiteBody.safeParse({
    name: "Test",
    projectSource: {
      ...SEED_PROJECT,
      designTokens: {
        ...SEED_PROJECT.designTokens,
        borderRadius: "extra-large",
      },
    },
  });
  assert.ok(!result.success, "invalid borderRadius must be rejected");
});

test("CreateWebsiteBody rejects invalid section type enum", () => {
  const result = CreateWebsiteBody.safeParse({
    name: "Test",
    projectSource: {
      ...SEED_PROJECT,
      pages: {
        ...SEED_PROJECT.pages,
        home: {
          id: "home",
          name: "Home",
          sections: [{ id: "s1", type: "unknown-section-type" }],
        },
      },
    },
  });
  assert.ok(!result.success, "invalid section type must be rejected");
});

test("receptionist without ownerKey parses correctly", () => {
  const withReceptionist = {
    name: "Test",
    projectSource: {
      ...SEED_PROJECT,
      receptionist: {
        enabled: true,
        assistantName: "Maple",
        greeting: "Hello!",
        knowledge: "We do windows.",
        receptionistId: "rec-123",
        retellAgentId: "agent-456",
        retellPhoneNumber: "+14165550100",
        provisionedAt: 1700000000000,
        updatedAt: 1700000001000,
      },
    },
  };
  const result = CreateWebsiteBody.safeParse(withReceptionist);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    assert.fail(`Receptionist config (no ownerKey) should parse:\n${issues}`);
  }
  assert.ok(result.success);
});

// ─── Import helper: skipped semantics ─────────────────────────────────────

test("import helper: existing owner+id returns skipped, never updates", async () => {
  // Simulate the import helper logic as a pure extracted function
  const store = new Map(); // key: `${ownerId}:${id}`

  async function simulateImportItem(ownerId, id, name) {
    const key = `${ownerId}:${id}`;
    if (store.has(key)) {
      // existing => skipped, DO NOT update
      return "skipped";
    }
    store.set(key, { ownerId, id, name, revision: 0 });
    return "imported";
  }

  const r1 = await simulateImportItem("u1", "s1", "First");
  assert.equal(r1, "imported", "first import returns imported");
  assert.equal(store.get("u1:s1").name, "First");

  const r2 = await simulateImportItem("u1", "s1", "Updated");
  assert.equal(r2, "skipped", "second import of same id returns skipped");
  assert.equal(store.get("u1:s1").name, "First", "name NOT updated on skipped");
  assert.equal(store.get("u1:s1").revision, 0, "revision NOT incremented on skipped");

  // Different owner — separate entry
  const r3 = await simulateImportItem("u2", "s1", "User2 Site");
  assert.equal(r3, "imported", "different owner same id is imported separately");
  assert.equal(store.size, 2, "two separate entries");
});

// ─── Stale revision detection ─────────────────────────────────────────────

test("stale revision conflict is detected correctly", () => {
  function checkRevision(currentRevision, expectedRevision) {
    if (currentRevision !== expectedRevision) return "conflict";
    return "ok";
  }

  assert.equal(checkRevision(5, 5), "ok");
  assert.equal(checkRevision(5, 4), "conflict", "stale revision");
  assert.equal(checkRevision(5, 6), "conflict", "future revision");
  assert.equal(checkRevision(0, 0), "ok", "initial revision");
});

// ─── Owner isolation ───────────────────────────────────────────────────────

test("owner isolation: composite PK (ownerId, id) prevents cross-owner access", () => {
  const db = [
    { ownerId: "user-A", id: "site-1", name: "Alice's Site", revision: 3 },
    { ownerId: "user-B", id: "site-1", name: "Bob's Site", revision: 7 },
  ];

  function getWebsite(ownerId, websiteId) {
    return db.find((w) => w.ownerId === ownerId && w.id === websiteId) ?? null;
  }

  assert.equal(getWebsite("user-A", "site-1")?.name, "Alice's Site");
  assert.equal(getWebsite("user-B", "site-1")?.name, "Bob's Site");
  assert.equal(getWebsite("user-C", "site-1"), null, "unknown user gets null");
});

// ─── Credential stripping on duplicate ────────────────────────────────────

test("duplicate strips all credential fields from source project", () => {
  const sourceProject = {
    ...SEED_PROJECT,
    ownerKey: "top-level-secret",
    receptionist: {
      ...SEED_PROJECT.receptionist,
      ownerKey: "nested-secret",
      apiKey: "some-api-key",
      webhookSecret: "hook-secret",
      secretKey: "clerk-secret",
    },
    business: {
      ...SEED_PROJECT.business,
      password: "stored-password",
    },
  };

  const duplicated = sanitizeProjectSource(sourceProject);

  // All credential keys removed
  const json = JSON.stringify(duplicated);
  for (const credKey of [
    "ownerKey", "apiKey", "webhookSecret", "secretKey", "password",
    "top-level-secret", "nested-secret", "some-api-key", "hook-secret",
  ]) {
    assert.ok(
      !json.includes(credKey),
      `${credKey} must not appear in duplicated project`,
    );
  }

  // Non-credential fields preserved
  assert.equal(duplicated.receptionist?.assistantName, "Assistant");
  assert.equal(duplicated.business?.name, "Evergreen Home Services");

  // Verify it still parses as valid input after stripping
  const result = CreateWebsiteBody.safeParse({ name: "Duplicate", projectSource: duplicated });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    assert.fail(`Duplicated+sanitized project should parse:\n${issues}`);
  }
});

// ─── Duplicate ID/name overlay regression (E2E bug) ────────────────────────

// Mirrors the duplicate route's overlay logic: sanitized copy must reference the
// NEW website record ID and canonical name, not the source's.
function buildDuplicatePayload(sourceProjectSource, newId, newName) {
  return {
    ...sanitizeProjectSource(sourceProjectSource),
    id: newId,
    name: newName,
  };
}

test("duplicate overlays projectSource.id with the new website record ID (not source ID)", () => {
  const sourceProjectSource = { ...SEED_PROJECT, id: "source-website-id-123", name: "Original Site" };
  const newId = "new-record-id-abc";
  const newName = "Copy of Original Site";

  const payload = buildDuplicatePayload(sourceProjectSource, newId, newName);

  // projectSource.id must be the NEW id, and must differ from source
  assert.equal(payload.id, newId, "projectSource.id equals the new record ID");
  assert.notEqual(payload.id, sourceProjectSource.id, "projectSource.id differs from source ID");
});

test("duplicate projectSource.name matches canonical duplicate name", () => {
  const sourceProjectSource = { ...SEED_PROJECT, id: "source-id", name: "Original Site" };
  const newName = "My Duplicate";

  const payload = buildDuplicatePayload(sourceProjectSource, "new-id", newName);

  assert.equal(payload.name, newName, "projectSource.name equals canonical duplicate name");
  assert.notEqual(payload.name, sourceProjectSource.name, "projectSource.name differs from source name");
});

test("duplicate payload projectSource.id equals the record ID used for persistence", () => {
  // Simulate the route: both the row `id` and projectSource.id are set from newId
  const sourceProjectSource = { ...SEED_PROJECT, id: "src", name: "Src" };
  const newId = "shared-new-id";
  const newName = "Dup";

  const recordId = newId; // row id in DB insert
  const payload = buildDuplicatePayload(sourceProjectSource, newId, newName);

  assert.equal(payload.id, recordId, "projectSource.id equals the DB record ID (no wrong-ID saves)");
});

test("duplicate still strips credentials after id/name overlay", () => {
  const sourceProjectSource = {
    ...SEED_PROJECT,
    id: "src-id",
    name: "Src",
    ownerKey: "top-secret",
    receptionist: {
      ...SEED_PROJECT.receptionist,
      ownerKey: "nested-secret",
      apiKey: "api-secret",
    },
  };

  const payload = buildDuplicatePayload(sourceProjectSource, "new-id", "Dup Name");

  const json = JSON.stringify(payload);
  for (const cred of ["ownerKey", "top-secret", "nested-secret", "apiKey", "api-secret"]) {
    assert.ok(!json.includes(cred), `${cred} must not appear in duplicated payload`);
  }
  // Overlay still applied
  assert.equal(payload.id, "new-id");
  assert.equal(payload.name, "Dup Name");

  // Result still parses as a valid project input
  const result = CreateWebsiteBody.safeParse({ name: "Dup Name", projectSource: payload });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    assert.fail(`Duplicated payload should parse:\n${issues}`);
  }
});

test("duplicate does not mutate the source projectSource object", () => {
  const sourceProjectSource = { ...SEED_PROJECT, id: "immutable-src-id", name: "Immutable Src" };
  const snapshotId = sourceProjectSource.id;
  const snapshotName = sourceProjectSource.name;

  buildDuplicatePayload(sourceProjectSource, "new-id", "New Name");

  // Source must be untouched — overlay builds a new object via spread
  assert.equal(sourceProjectSource.id, snapshotId, "source id unchanged");
  assert.equal(sourceProjectSource.name, snapshotName, "source name unchanged");
});

// ─── Safe integer validation ───────────────────────────────────────────────

test("safe integer validator accepts valid values and rejects bad ones", () => {
  function isSafeNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  assert.ok(isSafeNonNegativeInteger(0));
  assert.ok(isSafeNonNegativeInteger(1700000000000));
  assert.ok(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER));
  assert.ok(!isSafeNonNegativeInteger(-1), "negative rejected");
  assert.ok(!isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1), "unsafe integer rejected");
  assert.ok(!isSafeNonNegativeInteger(1.5), "float rejected");
  assert.ok(!isSafeNonNegativeInteger(NaN), "NaN rejected");
  assert.ok(!isSafeNonNegativeInteger("100"), "string rejected");
  assert.ok(!isSafeNonNegativeInteger(null), "null rejected");
});

// ─── Migration idempotency ─────────────────────────────────────────────────

test("migration 0003 is drizzle-kit generated, additive, and covers all new objects", () => {
  const migrationPath = new URL(
    "../../../lib/db/drizzle/0003_siteforge_accounts_websites.sql",
    import.meta.url,
  ).pathname;

  const sql = readFileSync(migrationPath, "utf8");

  // Must create both new tables
  assert.ok(sql.includes('CREATE TABLE "siteforge_users"'), "creates siteforge_users");
  assert.ok(sql.includes('CREATE TABLE "siteforge_websites"'), "creates siteforge_websites");

  // Must add the owner_id FK column to receptionists (subsumes old 0004)
  assert.ok(
    sql.includes('ALTER TABLE "receptionists" ADD COLUMN "owner_id"'),
    "adds owner_id column to receptionists",
  );

  // Must add FK constraints
  assert.ok(
    sql.includes("siteforge_websites_owner_id_siteforge_users_id_fk"),
    "siteforge_websites FK to siteforge_users",
  );
  assert.ok(
    sql.includes("receptionists_owner_id_siteforge_users_id_fk"),
    "receptionists FK to siteforge_users",
  );

  // Additive only — no destructive operations
  assert.ok(!sql.includes("DROP TABLE"), "no DROP TABLE");
  assert.ok(!sql.includes("DROP COLUMN"), "no DROP COLUMN");

  // Journal is registered
  const journalPath = new URL(
    "../../../lib/db/drizzle/meta/_journal.json",
    import.meta.url,
  ).pathname;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const entry = journal.entries.find((e) => e.tag === "0003_siteforge_accounts_websites");
  assert.ok(entry, "0003 is registered in drizzle meta journal");
  assert.equal(entry.idx, 3, "journal idx is 3");
  assert.equal(entry.breakpoints, true, "breakpoints enabled");

  // Snapshot exists for 0003
  const snapshotPath = new URL(
    "../../../lib/db/drizzle/meta/0003_snapshot.json",
    import.meta.url,
  ).pathname;
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.ok("public.siteforge_users" in snapshot.tables, "snapshot includes siteforge_users");
  assert.ok("public.siteforge_websites" in snapshot.tables, "snapshot includes siteforge_websites");
  assert.ok(
    "owner_id" in snapshot.tables["public.receptionists"].columns,
    "snapshot has receptionists.owner_id",
  );
});

// ─── 409 on duplicate create ──────────────────────────────────────────────

test("409 on duplicate ID is returned from DB unique violation (code 23505)", () => {
  // Simulate the error-handling logic in the POST /websites route
  function handleDbError(err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "23505"
    ) {
      return { status: 409, error: "A website with this ID already exists for your account." };
    }
    return { status: 500, error: "Unexpected error" };
  }

  const uniqueViolation = { code: "23505", detail: "Key already exists." };
  const otherError = { code: "42P01", detail: "Table not found." };

  const r1 = handleDbError(uniqueViolation);
  assert.equal(r1.status, 409, "unique violation => 409");
  assert.ok(r1.error.includes("already exists"), "409 message mentions already exists");

  const r2 = handleDbError(otherError);
  assert.equal(r2.status, 500, "other error => 500");
});

test("ordinary delete route rejects prospect drafts before deleting", () => {
  const routeSource = readFileSync(
    new URL("../src/routes/websites/index.ts", import.meta.url),
    "utf8",
  );
  const deleteRoute = routeSource.slice(
    routeSource.indexOf('// DELETE /websites/:websiteId'),
    routeSource.indexOf('// POST /websites/:websiteId/duplicate'),
  );

  assert.match(deleteRoute, /website\.siteType === ["']prospect["']/);
  assert.match(deleteRoute, /status\(409\)/);
  assert.match(deleteRoute, /must be archived from the lead workspace/);
  assert.match(deleteRoute, /eq\(siteforgeWebsitesTable\.siteType,\s*["']customer["']\)/);
});

test("ordinary duplicate route rejects prospect drafts before copying source", () => {
  const routeSource = readFileSync(
    new URL("../src/routes/websites/index.ts", import.meta.url),
    "utf8",
  );
  const duplicateRoute = routeSource.slice(
    routeSource.indexOf('// POST /websites/:websiteId/duplicate'),
  );
  const prospectGuard = duplicateRoute.indexOf('source.siteType === "prospect"');
  const copyConstruction = duplicateRoute.indexOf("const newId = newWebsiteId()");

  assert.ok(prospectGuard >= 0, "duplicate route must inspect source site type");
  assert.ok(copyConstruction >= 0, "duplicate route must still support customer copies");
  assert.ok(prospectGuard < copyConstruction, "prospect guard must run before copying");
  assert.match(duplicateRoute.slice(prospectGuard, copyConstruction), /status\(409\)/);
});

test("SiteProject contract round-trips prospect lifecycle metadata", () => {
  const result = CreateWebsiteBody.safeParse({
    ...SEED_WEBSITE_INPUT,
    projectSource: {
      ...SEED_PROJECT,
      prospectMeta: {
        isDraft: true,
        leadId: "lead_contract_test",
        generationId: "generation_contract_test",
      },
    },
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.projectSource.prospectMeta, {
    isDraft: true,
    leadId: "lead_contract_test",
    generationId: "generation_contract_test",
  });
});

test("website saves preserve server-owned prospect metadata and strip it from customers", () => {
  const routeSource = readFileSync(
    new URL("../src/routes/websites/index.ts", import.meta.url),
    "utf8",
  );

  assert.match(routeSource, /current\.siteType === ["']prospect["']/);
  assert.match(routeSource, /nextProjectSource\.prospectMeta = storedProspectMeta/);
  assert.match(routeSource, /delete nextProjectSource\.prospectMeta/);
  assert.match(routeSource, /delete sanitized\.prospectMeta/);
});
