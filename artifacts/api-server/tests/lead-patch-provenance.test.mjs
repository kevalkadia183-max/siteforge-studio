/**
 * PATCH /leads/:leadId provenance integrity — DATABASE-BACKED (Task #33).
 *
 * Proves the root provenance-bypass fix outside outreach: a full Studio-style
 * PATCH payload must NOT promote unchanged imported facts to `user_provided`.
 * Only fields whose EFFECTIVE stored value actually changes may get a
 * user_provided source. Verified end-to-end against real Postgres through the
 * EXACT helper the route calls (recordLeadEditProvenance), run inside the same
 * transaction shape as the route (UPDATE ... then recordLeadEditProvenance),
 * and cross-checked with loadApprovedFacts (the outreach fact loader).
 *
 * Covers:
 *  - import-style lead with imported businessName/category/city sources
 *  - full payload changing ONLY pipeline status → imported facts stay
 *    imported-only; NO user_provided source; loadApprovedFacts excludes them
 *  - full payload repeating current values → no-op, no provenance, no activity
 *  - an ACTUAL businessName value change → user_provided source for the NEW
 *    current value; loadApprovedFacts now includes businessName as user_provided
 *  - owner isolation
 *
 * Skips gracefully if no DATABASE_URL is configured. Unique fixtures + cleanup.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-patch-prov-"));
const outFile = join(outputDir, "patch-prov-entry.mjs");

await build({
  stdin: {
    contents: `
      import { and, eq } from "drizzle-orm";
      import {
        db,
        pool,
        siteforgeUsersTable,
        leadsTable,
        leadSourcesTable,
        leadActivitiesTable,
      } from "@workspace/db";
      import { recordLeadEditProvenance } from "./src/routes/lead-acquisition/lead-ops.ts";
      import { loadApprovedFacts } from "./src/routes/lead-acquisition/outreach-ops.ts";

      export async function seedOwner(id) {
        await db.insert(siteforgeUsersTable).values({ id, email: id + "@test.local" }).onConflictDoNothing();
      }

      export async function seedLead(l) {
        await db.insert(leadsTable).values({
          id: l.id,
          ownerId: l.ownerId,
          businessName: l.businessName,
          category: l.category ?? null,
          city: l.city ?? null,
          pipelineStatus: l.pipelineStatus ?? "new",
          websiteStatus: l.websiteStatus ?? "unknown",
        });
      }

      export async function seedSource(row) {
        await db.insert(leadSourcesTable).values({
          id: row.id, leadId: row.leadId, ownerId: row.ownerId,
          fieldName: row.fieldName, value: row.value, provenance: row.provenance,
        });
      }

      // Mirrors the PATCH transaction body: UPDATE the lead, then call the EXACT
      // recordLeadEditProvenance helper the route uses. Returns changedFields.
      export async function runPatch(ownerId, leadId, input) {
        return db.transaction(async (tx) => {
          const [existing] = await tx.select().from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1).for("update");
          if (!existing) throw new Error("fixture lead missing");

          const updates = { updatedAt: new Date() };
          for (const [k, v] of Object.entries(input)) {
            if (v === undefined) continue;
            // businessName/pipelineStatus/websiteStatus are non-nullable; others null-clear.
            if (k === "businessName" || k === "pipelineStatus" || k === "websiteStatus") {
              updates[k] = v;
            } else {
              updates[k] = v ?? null;
            }
          }
          const [updated] = await tx.update(leadsTable).set(updates)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).returning();

          const changedFields = await recordLeadEditProvenance(tx, {
            ownerId, leadId, existing, updated, input, performedBy: ownerId,
          });
          return { changedFields, updated };
        });
      }

      export async function getSources(ownerId, leadId, fieldName) {
        return db.select().from(leadSourcesTable)
          .where(and(
            eq(leadSourcesTable.ownerId, ownerId),
            eq(leadSourcesTable.leadId, leadId),
            eq(leadSourcesTable.fieldName, fieldName),
          ));
      }

      export async function getActivityCount(ownerId, leadId) {
        const rows = await db.select({ id: leadActivitiesTable.id }).from(leadActivitiesTable)
          .where(and(eq(leadActivitiesTable.ownerId, ownerId), eq(leadActivitiesTable.leadId, leadId)));
        return rows.length;
      }

      // Loads outreach approved facts through the EXACT loader used by the
      // create-draft route (runs inside a tx like the route does).
      export async function approvedFacts(ownerId, leadId) {
        return db.transaction(async (tx) => {
          const [lead] = await tx.select().from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1);
          return loadApprovedFacts(tx, ownerId, lead);
        });
      }

      export async function cleanupOwner(ownerId) {
        const leads = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.ownerId, ownerId));
        for (const l of leads) {
          await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.leadId, l.id));
          await db.delete(leadSourcesTable).where(eq(leadSourcesTable.leadId, l.id));
        }
        await db.delete(leadsTable).where(eq(leadsTable.ownerId, ownerId));
        await db.delete(siteforgeUsersTable).where(eq(siteforgeUsersTable.id, ownerId));
      }

      export async function closePool() { await pool.end(); }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "patch-prov-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  logLevel: "silent",
  banner: {
    js: `import { createRequire as __cr } from "node:module"; globalThis.require = __cr(import.meta.url);`,
  },
});

const mod = await import(pathToFileURL(outFile).href);
const uid = (p) => `${p}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const ownerA = uid("pp-owner-A");
const ownerB = uid("pp-owner-B");

test.after(async () => {
  if (!hasDb) return;
  await mod.cleanupOwner(ownerA);
  await mod.cleanupOwner(ownerB);
  await mod.closePool();
});

// Seed an import-style lead: only `imported` sources for its facts.
async function seedImportedLead(ownerId, leadId, over = {}) {
  await mod.seedLead({
    id: leadId, ownerId,
    businessName: "Imported Plumbing", category: "Plumber", city: "Austin",
    pipelineStatus: "new", ...over,
  });
  await mod.seedSource({ id: uid("src"), leadId, ownerId, fieldName: "businessName", value: "Imported Plumbing", provenance: "imported" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId, fieldName: "category", value: "Plumber", provenance: "imported" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId, fieldName: "city", value: "Austin", provenance: "imported" });
}

test("full payload changing ONLY pipeline status does not promote imported facts", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerA);
  const leadId = uid("pp-lead-pipeline");
  await seedImportedLead(ownerA, leadId);

  // Studio submits its whole object; only pipelineStatus differs.
  const { changedFields } = await mod.runPatch(ownerA, leadId, {
    businessName: "Imported Plumbing",
    category: "Plumber",
    city: "Austin",
    pipelineStatus: "contacted",
  });
  assert.deepEqual(changedFields, ["pipelineStatus"], "only pipeline status changed");

  // No user_provided source was created for any imported fact.
  for (const f of ["businessName", "category", "city"]) {
    const srcs = await mod.getSources(ownerA, leadId, f);
    assert.equal(srcs.length, 1, f + " still has exactly one source");
    assert.equal(srcs[0].provenance, "imported", f + " stays imported-only");
  }

  // loadApprovedFacts (outreach) still EXCLUDES the imported businessName.
  const facts = await mod.approvedFacts(ownerA, leadId);
  assert.equal(facts.businessName, undefined, "imported businessName excluded from outreach facts");
  assert.equal(facts.category, undefined);
  assert.equal(facts.city, undefined);
});

test("full payload repeating current values is a no-op (no provenance, no activity)", { skip: !hasDb }, async () => {
  const leadId = uid("pp-lead-noop");
  await seedImportedLead(ownerA, leadId);
  const before = await mod.getActivityCount(ownerA, leadId);

  const { changedFields } = await mod.runPatch(ownerA, leadId, {
    businessName: "Imported Plumbing",
    category: "Plumber",
    city: "Austin",
    pipelineStatus: "new",
  });
  assert.deepEqual(changedFields, [], "nothing changed");

  for (const f of ["businessName", "category", "city"]) {
    const srcs = await mod.getSources(ownerA, leadId, f);
    assert.equal(srcs.length, 1, f + " unchanged");
    assert.equal(srcs[0].provenance, "imported");
  }
  assert.equal(await mod.getActivityCount(ownerA, leadId), before, "no 'updated' activity added");
});

test("an ACTUAL businessName edit writes user_provided for the NEW value and approves it", { skip: !hasDb }, async () => {
  const leadId = uid("pp-lead-edit");
  await seedImportedLead(ownerA, leadId);

  const { changedFields } = await mod.runPatch(ownerA, leadId, {
    businessName: "Real Plumbing Co", // actual change
    category: "Plumber",              // unchanged
    city: "Austin",                   // unchanged
  });
  assert.deepEqual(changedFields, ["businessName"], "only businessName actually changed");

  const bnSources = await mod.getSources(ownerA, leadId, "businessName");
  const provenances = bnSources.map((s) => s.provenance).sort();
  assert.deepEqual(provenances, ["imported", "user_provided"], "adds user_provided alongside imported");
  const up = bnSources.find((s) => s.provenance === "user_provided");
  assert.equal(up.value, "Real Plumbing Co", "user_provided value is the NEW current stored value");

  // category/city unchanged → still imported-only.
  assert.equal((await mod.getSources(ownerA, leadId, "category")).length, 1);
  assert.equal((await mod.getSources(ownerA, leadId, "city")).length, 1);

  // loadApprovedFacts now INCLUDES businessName as user_provided (approved),
  // but NOT category/city (still imported).
  const facts = await mod.approvedFacts(ownerA, leadId);
  assert.ok(facts.businessName, "businessName now approved");
  assert.equal(facts.businessName.provenance, "user_provided");
  assert.equal(facts.businessName.value, "Real Plumbing Co");
  assert.equal(facts.category, undefined, "category still excluded");
  assert.equal(facts.city, undefined, "city still excluded");
});

test("owner isolation: PATCH on ownerA does not affect ownerB's same-named lead", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerB);
  const leadA = uid("pp-iso-A");
  const leadB = uid("pp-iso-B");
  await seedImportedLead(ownerA, leadA);
  await seedImportedLead(ownerB, leadB);

  await mod.runPatch(ownerA, leadA, { businessName: "Changed A" });

  // ownerB untouched — still imported-only, still excluded from outreach facts.
  const bSources = await mod.getSources(ownerB, leadB, "businessName");
  assert.equal(bSources.length, 1);
  assert.equal(bSources[0].provenance, "imported");
  const factsB = await mod.approvedFacts(ownerB, leadB);
  assert.equal(factsB.businessName, undefined, "ownerB businessName stays excluded");
});
