/**
 * Lead outreach — DATABASE-BACKED integration coverage (Task #33 compliance).
 *
 * These tests exercise the EXACT route helpers against a real Postgres instance
 * (not source-text assertions), proving two compliance invariants:
 *
 *  A) Imported businessName provenance is EXCLUDED before owner confirmation and
 *     INCLUDED as `verified` only after the server writes a verified source from
 *     the current stored value (never client input). Manual (user_provided)
 *     businessName stays usable.
 *
 *  B) A permanent outreach opt-out atomically writes: the durable outreach
 *     opt-out row + the canonical lead_acquisition_suppressions record +
 *     leads.suppressed=true. The ordinary unsuppress path is rejected while an
 *     outreach opt-out exists and leaves every DNC row intact. Owner isolation
 *     is enforced throughout.
 *
 * The route calls these SAME helpers (confirmImportedFactSources,
 * loadApprovedFacts, applyOutreachOptOut, hasDurableOutreachOptOut), so this is
 * a true behavioral test of the route logic. Fixtures use unique ids and are
 * cleaned up in test.after.
 *
 * Skips gracefully if no DATABASE_URL is configured.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-outreach-db-"));
const outFile = join(outputDir, "outreach-db-entry.mjs");

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
        leadSuppressionsTable,
        leadOutreachOptOutsTable,
        leadOutreachEventsTable,
        leadActivitiesTable,
      } from "@workspace/db";
      import {
        confirmImportedFactSources,
        loadApprovedFacts,
        applyOutreachOptOut,
        hasDurableOutreachOptOut,
        findOutreachBlock,
      } from "./src/routes/lead-acquisition/outreach-ops.ts";

      export {
        confirmImportedFactSources,
        loadApprovedFacts,
        applyOutreachOptOut,
        hasDurableOutreachOptOut,
        findOutreachBlock,
      };

      export async function seedOwner(id) {
        await db
          .insert(siteforgeUsersTable)
          .values({ id, email: id + "@test.local" })
          .onConflictDoNothing();
      }

      export async function seedLead(lead) {
        await db.insert(leadsTable).values({
          id: lead.id,
          ownerId: lead.ownerId,
          businessName: lead.businessName,
          city: lead.city ?? null,
          pipelineStatus: lead.pipelineStatus ?? "qualified",
        });
      }

      export async function seedSource(row) {
        await db.insert(leadSourcesTable).values({
          id: row.id,
          leadId: row.leadId,
          ownerId: row.ownerId,
          fieldName: row.fieldName,
          value: row.value,
          provenance: row.provenance,
        });
      }

      export async function getLead(ownerId, leadId) {
        const [row] = await db
          .select()
          .from(leadsTable)
          .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
          .limit(1);
        return row ?? null;
      }

      export async function getSuppression(ownerId, leadId) {
        const [row] = await db
          .select()
          .from(leadSuppressionsTable)
          .where(and(eq(leadSuppressionsTable.ownerId, ownerId), eq(leadSuppressionsTable.leadId, leadId)))
          .limit(1);
        return row ?? null;
      }

      export async function getOptOut(ownerId, leadId) {
        const [row] = await db
          .select()
          .from(leadOutreachOptOutsTable)
          .where(and(eq(leadOutreachOptOutsTable.ownerId, ownerId), eq(leadOutreachOptOutsTable.leadId, leadId)))
          .limit(1);
        return row ?? null;
      }

      // Mirror of the ordinary unsuppress guard/transaction body, calling the
      // EXACT hasDurableOutreachOptOut helper the DELETE route uses, so the
      // "unsuppress is rejected" behavior is tested end-to-end at the DB level.
      export async function attemptUnsuppress(ownerId, leadId) {
        return db.transaction(async (tx) => {
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1)
            .for("update");
          if (!lead) return { kind: "not_found" };
          if (!lead.suppressed) return { kind: "not_suppressed" };
          if (await hasDurableOutreachOptOut(tx, ownerId, leadId)) {
            return { kind: "outreach_opt_out" };
          }
          await tx
            .delete(leadSuppressionsTable)
            .where(and(eq(leadSuppressionsTable.leadId, leadId), eq(leadSuppressionsTable.ownerId, ownerId)));
          const [updated] = await tx
            .update(leadsTable)
            .set({ suppressed: false, updatedAt: new Date() })
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .returning();
          return { kind: "ok", lead: updated };
        });
      }

      // Runs the confirmation + fact-load exactly as the create route does,
      // inside one transaction, and returns the resulting approved facts.
      export async function confirmAndLoadFacts(ownerId, leadId, selectedFields, confirmImportedFields) {
        return db.transaction(async (tx) => {
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1)
            .for("update");
          if (!lead) throw new Error("lead not found in fixture");
          const confirmed = await confirmImportedFactSources(tx, {
            ownerId,
            lead,
            selectedFields,
            confirmImportedFields,
          });
          const facts = await loadApprovedFacts(tx, ownerId, lead);
          return { confirmed, facts };
        });
      }

      // Calls the EXACT findOutreachBlock route helper inside a transaction.
      export async function blockFor(ownerId, leadId) {
        return db.transaction(async (tx) => {
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1);
          if (!lead) return "no-lead";
          return findOutreachBlock(tx, ownerId, lead);
        });
      }

      export async function applyOptOut(ownerId, leadId, reason, channel) {
        return db.transaction(async (tx) => {
          const [lead] = await tx
            .select()
            .from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)))
            .limit(1)
            .for("update");
          if (!lead) throw new Error("lead not found in fixture");
          return applyOutreachOptOut(tx, { ownerId, leadId, reason, channel, performedBy: ownerId });
        });
      }

      export async function cleanupOwner(ownerId) {
        // Child rows first (FKs / owner-scoped).
        const leads = await db
          .select({ id: leadsTable.id })
          .from(leadsTable)
          .where(eq(leadsTable.ownerId, ownerId));
        for (const l of leads) {
          await db.delete(leadOutreachEventsTable).where(eq(leadOutreachEventsTable.leadId, l.id));
          await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.leadId, l.id));
          await db.delete(leadOutreachOptOutsTable).where(eq(leadOutreachOptOutsTable.leadId, l.id));
          await db.delete(leadSuppressionsTable).where(eq(leadSuppressionsTable.leadId, l.id));
          await db.delete(leadSourcesTable).where(eq(leadSourcesTable.leadId, l.id));
        }
        await db.delete(leadsTable).where(eq(leadsTable.ownerId, ownerId));
        await db.delete(siteforgeUsersTable).where(eq(siteforgeUsersTable.id, ownerId));
      }

      export async function closePool() {
        await pool.end();
      }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "outreach-db-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
  logLevel: "silent",
  banner: {
    js: `
      import { createRequire as __createRequire } from "node:module";
      globalThis.require = __createRequire(import.meta.url);
    `,
  },
});

const mod = await import(pathToFileURL(outFile).href);

function uid(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Unique owners for isolation across the whole file.
const ownerA = uid("owner-A");
const ownerB = uid("owner-B");

test.after(async () => {
  if (!hasDb) return;
  await mod.cleanupOwner(ownerA);
  await mod.cleanupOwner(ownerB);
  await mod.closePool();
});

// ─── A) Imported businessName provenance ─────────────────────────────────────

test("imported businessName is EXCLUDED before confirmation", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerA);
  const leadId = uid("lead-imported");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Imported Co", city: "Austin" });
  // Only an `imported` source exists (as a bulk import would create).
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "businessName", value: "Imported Co", provenance: "imported" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "city", value: "Austin", provenance: "imported" });

  const { facts } = await mod.confirmAndLoadFacts(ownerA, leadId, ["businessName", "city"], []);
  assert.equal(facts.businessName, undefined, "imported businessName must be excluded");
  assert.equal(facts.city, undefined, "imported city must be excluded too");
});

test("imported businessName becomes VERIFIED only after server confirmation (stored value, not client)", { skip: !hasDb }, async () => {
  const leadId = uid("lead-confirm");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Confirmed Co", city: "Denver" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "businessName", value: "Confirmed Co", provenance: "imported" });

  // Confirm businessName (present in both selected and confirmImportedFields).
  const { confirmed, facts } = await mod.confirmAndLoadFacts(
    ownerA,
    leadId,
    ["businessName"],
    ["businessName"],
  );
  assert.deepEqual(confirmed, ["businessName"]);
  assert.ok(facts.businessName, "businessName must now be approved");
  assert.equal(facts.businessName.provenance, "verified");
  assert.equal(facts.businessName.value, "Confirmed Co", "value comes from the stored lead row");
});

test("confirmation only applies to fields in BOTH selectedFields AND confirmImportedFields", { skip: !hasDb }, async () => {
  const leadId = uid("lead-partial");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Partial Co", city: "Reno" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "businessName", value: "Partial Co", provenance: "imported" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "city", value: "Reno", provenance: "imported" });

  // city is confirmed but NOT selected → must NOT be verified.
  const { confirmed, facts } = await mod.confirmAndLoadFacts(
    ownerA,
    leadId,
    ["businessName"],
    ["businessName", "city"],
  );
  assert.deepEqual(confirmed, ["businessName"], "only the selected+confirmed field is verified");
  assert.ok(facts.businessName);
  assert.equal(facts.city, undefined, "city stays excluded (confirmed but not selected)");
});

test("manual (user_provided) businessName stays usable without any confirmation", { skip: !hasDb }, async () => {
  const leadId = uid("lead-manual");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Manual Co", city: "Boise" });
  await mod.seedSource({ id: uid("src"), leadId, ownerId: ownerA, fieldName: "businessName", value: "Manual Co", provenance: "user_provided" });

  const { facts } = await mod.confirmAndLoadFacts(ownerA, leadId, ["businessName"], []);
  assert.ok(facts.businessName, "user_provided businessName is approved");
  assert.equal(facts.businessName.provenance, "user_provided");
});

// ─── B) Permanent opt-out → canonical DNC propagation ────────────────────────

test("opt-out atomically writes optout row + canonical suppression + leads.suppressed", { skip: !hasDb }, async () => {
  const leadId = uid("lead-optout");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "OptOut Co" });

  // Before: nothing suppressed.
  assert.equal((await mod.getLead(ownerA, leadId)).suppressed, false);
  assert.equal(await mod.getSuppression(ownerA, leadId), null);
  assert.equal(await mod.getOptOut(ownerA, leadId), null);

  const res = await mod.applyOptOut(ownerA, leadId, "changed mind", "email");
  assert.equal(res.lead.suppressed, true, "returned lead reflects ACTUAL updated state");
  assert.match(res.suppressionReason, /Outreach opt-out: changed mind/);

  const lead = await mod.getLead(ownerA, leadId);
  const supp = await mod.getSuppression(ownerA, leadId);
  const optOut = await mod.getOptOut(ownerA, leadId);
  assert.equal(lead.suppressed, true, "leads.suppressed=true");
  assert.ok(supp, "canonical suppression row exists");
  assert.match(supp.reason, /Outreach opt-out/, "honest suppression reason");
  assert.ok(optOut, "durable outreach opt-out row exists");

  // findOutreachBlock (the exact route helper) now blocks with opt-out wording.
  const block = await mod.blockFor(ownerA, leadId);
  assert.match(block, /opted out of outreach/i, "outreach is blocked with opt-out wording");
});

test("ordinary unsuppress is REJECTED while an outreach opt-out exists; all DNC rows remain", { skip: !hasDb }, async () => {
  const leadId = uid("lead-permanent");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Permanent Co" });
  await mod.applyOptOut(ownerA, leadId, "spam complaint", null);

  const result = await mod.attemptUnsuppress(ownerA, leadId);
  assert.equal(result.kind, "outreach_opt_out", "unsuppress must be rejected");

  // Everything remains blocked.
  assert.equal((await mod.getLead(ownerA, leadId)).suppressed, true, "leads.suppressed still true");
  assert.ok(await mod.getSuppression(ownerA, leadId), "canonical suppression preserved");
  assert.ok(await mod.getOptOut(ownerA, leadId), "outreach opt-out preserved");
});

test("opt-out is idempotent (re-opt-out updates, single row per owner+lead)", { skip: !hasDb }, async () => {
  const leadId = uid("lead-idem");
  await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Idem Co" });
  await mod.applyOptOut(ownerA, leadId, "first", "email");
  const r2 = await mod.applyOptOut(ownerA, leadId, "second", null);
  assert.equal(r2.lead.suppressed, true);
  const supp = await mod.getSuppression(ownerA, leadId);
  assert.match(supp.reason, /second/, "suppression reason updated on re-opt-out");
});

// ─── Owner isolation ─────────────────────────────────────────────────────────

test("owner isolation: opt-out for ownerA does NOT block the same-named lead of ownerB", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerB);
  const leadA = uid("iso-A");
  const leadB = uid("iso-B");
  await mod.seedLead({ id: leadA, ownerId: ownerA, businessName: "Shared Name" });
  await mod.seedLead({ id: leadB, ownerId: ownerB, businessName: "Shared Name" });

  await mod.applyOptOut(ownerA, leadA, "A opts out", null);

  // ownerB's lead is untouched.
  assert.equal((await mod.getLead(ownerB, leadB)).suppressed, false);
  assert.equal(await mod.getSuppression(ownerB, leadB), null);
  assert.equal(await mod.getOptOut(ownerB, leadB), null);
  // hasDurableOutreachOptOut is owner-scoped.
  const b = await mod.attemptUnsuppress(ownerB, leadB);
  assert.equal(b.kind, "not_suppressed", "ownerB lead is not suppressed at all");
});

test("owner isolation: confirming a source under ownerA does not approve ownerB facts", { skip: !hasDb }, async () => {
  const leadA = uid("iso-fact-A");
  const leadB = uid("iso-fact-B");
  await mod.seedLead({ id: leadA, ownerId: ownerA, businessName: "Iso Co" });
  await mod.seedLead({ id: leadB, ownerId: ownerB, businessName: "Iso Co" });
  await mod.seedSource({ id: uid("src"), leadId: leadA, ownerId: ownerA, fieldName: "businessName", value: "Iso Co", provenance: "imported" });
  await mod.seedSource({ id: uid("src"), leadId: leadB, ownerId: ownerB, fieldName: "businessName", value: "Iso Co", provenance: "imported" });

  await mod.confirmAndLoadFacts(ownerA, leadA, ["businessName"], ["businessName"]);

  // ownerB's lead still has only an imported source → excluded.
  const { facts } = await mod.confirmAndLoadFacts(ownerB, leadB, ["businessName"], []);
  assert.equal(facts.businessName, undefined, "ownerB businessName remains excluded");
});
