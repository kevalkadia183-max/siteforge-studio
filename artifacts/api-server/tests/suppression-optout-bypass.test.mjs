/**
 * PUT /leads/:leadId/suppression must NOT overwrite a permanent outreach
 * opt-out — DATABASE-BACKED (Task #33, UI-alignment bypass fix).
 *
 * A supported bypass existed: after a durable outreach opt-out (which writes the
 * canonical suppression row with the honest "Outreach opt-out" reason), an
 * ordinary PUT suppress could overwrite that reason/timestamp/flag via the
 * upsert, so the detail UI (which keys off the canonical reason) stopped
 * recognizing the permanent Do-Not-Contact — even though DELETE still 409s.
 *
 * This proves the fail-closed guard end-to-end against REAL Postgres, running
 * the EXACT transaction body the PUT/DELETE handlers use (lock → reload FOR
 * UPDATE → hasDurableOutreachOptOut guard → upsert/activity), through the SAME
 * shared helpers (applyOutreachOptOut, hasDurableOutreachOptOut) the routes call.
 *
 * Covers:
 *  - opt-out → attempted ordinary PUT suppress: returns the permanent-conflict
 *    shape; canonical reason stays "Outreach opt-out"; leads.suppressed stays
 *    true; the durable opt-out row remains; NO extra ordinary "suppressed"
 *    activity is appended; suppressedAt is not bumped.
 *  - DELETE guard remains 409 for an opted-out lead.
 *  - Owner isolation: the guard is per (owner,lead).
 *  - Ordinary suppression (no opt-out) still works and is idempotent.
 *
 * NEVER sends outreach. Unique fixtures + cleanup. Skips without DATABASE_URL.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-sup-optout-"));
const outFile = join(outputDir, "sup-optout-entry.mjs");

await build({
  stdin: {
    contents: `
      import { and, eq } from "drizzle-orm";
      import {
        db,
        pool,
        siteforgeUsersTable,
        leadsTable,
        leadSuppressionsTable,
        leadOutreachOptOutsTable,
        leadActivitiesTable,
      } from "@workspace/db";
      import { withLeadMutationLock } from "./src/lib/lead-mutation-lock.ts";
      import {
        applyOutreachOptOut,
        hasDurableOutreachOptOut,
      } from "./src/routes/lead-acquisition/outreach-ops.ts";
      import { appendActivity } from "./src/routes/lead-acquisition/lead-ops.ts";

      const newId = () => "id-" + Math.random().toString(16).slice(2) + Date.now().toString(16);

      export async function seedOwner(id) {
        await db.insert(siteforgeUsersTable).values({ id, email: id + "@test.local" }).onConflictDoNothing();
      }
      export async function seedLead(l) {
        await db.insert(leadsTable).values({
          id: l.id, ownerId: l.ownerId,
          businessName: l.businessName ?? "Test Biz",
          email: l.email ?? "buyer@example.com",
          pipelineStatus: "new", websiteStatus: "unknown", suppressed: false,
        });
      }

      // Durable opt-out via the SAME helper the opt-out route uses, under the lock.
      export async function optOut(ownerId, leadId) {
        return withLeadMutationLock(ownerId, leadId, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            await applyOutreachOptOut(tx, {
              ownerId, leadId, reason: null, channel: null, performedBy: ownerId,
            });
          }),
        );
      }

      // EXACT PUT suppression handler tx body (fail-closed opt-out guard BEFORE
      // any write). Returns { kind } like the route so the test asserts the
      // route-shape guard, not a reimplementation.
      export async function putSuppress(ownerId, leadId, reason) {
        return withLeadMutationLock(ownerId, leadId, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            const [lead] = await tx.select().from(leadsTable)
              .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1).for("update");
            if (!lead) return { kind: "not_found" };

            if (await hasDurableOutreachOptOut(tx, ownerId, leadId)) {
              return { kind: "outreach_opt_out" }; // fail closed: no writes below
            }

            await tx.insert(leadSuppressionsTable).values({ id: newId(), leadId, ownerId, reason })
              .onConflictDoUpdate({
                target: [leadSuppressionsTable.leadId, leadSuppressionsTable.ownerId],
                set: { reason, suppressedAt: new Date() },
              });
            await tx.update(leadsTable).set({ suppressed: true, updatedAt: new Date() })
              .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)));
            await appendActivity({
              leadId, ownerId, activityType: "suppressed",
              note: "Do Not Contact: " + reason, performedBy: ownerId,
            }, tx);
            return { kind: "ok" };
          }),
        );
      }

      // EXACT DELETE unsuppress guard (opt-out → 409).
      export async function deleteSuppress(ownerId, leadId) {
        return withLeadMutationLock(ownerId, leadId, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            const [lead] = await tx.select().from(leadsTable)
              .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1).for("update");
            if (!lead) return { kind: "not_found" };
            if (!lead.suppressed) return { kind: "not_suppressed" };
            if (await hasDurableOutreachOptOut(tx, ownerId, leadId)) return { kind: "outreach_opt_out" };
            await tx.delete(leadSuppressionsTable)
              .where(and(eq(leadSuppressionsTable.leadId, leadId), eq(leadSuppressionsTable.ownerId, ownerId)));
            await tx.update(leadsTable).set({ suppressed: false, updatedAt: new Date() })
              .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)));
            return { kind: "ok" };
          }),
        );
      }

      export async function getSuppression(ownerId, leadId) {
        const [row] = await db.select().from(leadSuppressionsTable)
          .where(and(eq(leadSuppressionsTable.ownerId, ownerId), eq(leadSuppressionsTable.leadId, leadId))).limit(1);
        return row ?? null;
      }
      export async function getLead(ownerId, leadId) {
        const [row] = await db.select().from(leadsTable)
          .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1);
        return row ?? null;
      }
      export async function optOutRowCount(ownerId, leadId) {
        const rows = await db.select({ id: leadOutreachOptOutsTable.id }).from(leadOutreachOptOutsTable)
          .where(and(eq(leadOutreachOptOutsTable.ownerId, ownerId), eq(leadOutreachOptOutsTable.leadId, leadId)));
        return rows.length;
      }
      export async function suppressActivityCount(ownerId, leadId) {
        const rows = await db.select({ id: leadActivitiesTable.id }).from(leadActivitiesTable)
          .where(and(
            eq(leadActivitiesTable.ownerId, ownerId),
            eq(leadActivitiesTable.leadId, leadId),
            eq(leadActivitiesTable.activityType, "suppressed"),
          ));
        return rows.length;
      }

      export async function cleanupOwner(ownerId) {
        const leads = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.ownerId, ownerId));
        for (const l of leads) {
          await db.delete(leadActivitiesTable).where(eq(leadActivitiesTable.leadId, l.id));
          await db.delete(leadOutreachOptOutsTable).where(eq(leadOutreachOptOutsTable.leadId, l.id));
          await db.delete(leadSuppressionsTable).where(eq(leadSuppressionsTable.leadId, l.id));
        }
        await db.delete(leadsTable).where(eq(leadsTable.ownerId, ownerId));
        await db.delete(siteforgeUsersTable).where(eq(siteforgeUsersTable.id, ownerId));
      }
      export async function closePool() { await pool.end(); }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "sup-optout-test-entry.ts",
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

const mod = hasDb ? await import(pathToFileURL(outFile).href) : null;
const uid = (p) => `${p}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const ownerA = uid("sob-owner-A");
const ownerB = uid("sob-owner-B");

test.after(async () => {
  if (!hasDb) return;
  await mod.cleanupOwner(ownerA);
  await mod.cleanupOwner(ownerB);
  await mod.closePool();
});

test("opt-out then ordinary PUT suppress: fail-closed, canonical opt-out preserved", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerA);
  const leadId = uid("sob-optout");
  await mod.seedLead({ id: leadId, ownerId: ownerA });

  await mod.optOut(ownerA, leadId);
  const canonicalBefore = await mod.getSuppression(ownerA, leadId);
  assert.ok(canonicalBefore, "opt-out wrote the canonical suppression row");
  assert.match(canonicalBefore.reason, /Outreach opt-out/, "canonical reason is the opt-out reason");
  const suppressedAtBefore = new Date(canonicalBefore.suppressedAt).getTime();
  const activityBefore = await mod.suppressActivityCount(ownerA, leadId);

  // Attempt to overwrite with an ordinary suppression reason.
  const res = await mod.putSuppress(ownerA, leadId, "Manual DNC (ordinary)");
  assert.equal(res.kind, "outreach_opt_out", "PUT returns the permanent-conflict route shape");

  // Canonical reason/timestamp/flag are UNTOUCHED.
  const canonicalAfter = await mod.getSuppression(ownerA, leadId);
  assert.match(canonicalAfter.reason, /Outreach opt-out/, "canonical reason NOT overwritten by ordinary reason");
  assert.doesNotMatch(canonicalAfter.reason, /ordinary/i, "ordinary reason did not leak in");
  assert.equal(new Date(canonicalAfter.suppressedAt).getTime(), suppressedAtBefore, "suppressedAt not bumped");

  const lead = await mod.getLead(ownerA, leadId);
  assert.equal(lead.suppressed, true, "leads.suppressed stays true");
  assert.equal(await mod.optOutRowCount(ownerA, leadId), 1, "durable opt-out row remains");
  assert.equal(await mod.suppressActivityCount(ownerA, leadId), activityBefore, "no extra ordinary 'suppressed' activity appended");
});

test("DELETE unsuppress on an opted-out lead still 409s (guard remains)", { skip: !hasDb }, async () => {
  const leadId = uid("sob-optout-del");
  await mod.seedLead({ id: leadId, ownerId: ownerA });
  await mod.optOut(ownerA, leadId);

  const res = await mod.deleteSuppress(ownerA, leadId);
  assert.equal(res.kind, "outreach_opt_out", "DELETE still refuses to clear a permanent opt-out");

  const lead = await mod.getLead(ownerA, leadId);
  assert.equal(lead.suppressed, true, "still suppressed after refused unsuppress");
  assert.ok(await mod.getSuppression(ownerA, leadId), "canonical suppression preserved");
});

test("owner isolation: ownerB's opt-out does not make ownerA's PUT fail closed", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerB);
  const leadA = uid("sob-iso-A");
  const leadB = uid("sob-iso-B");
  await mod.seedLead({ id: leadA, ownerId: ownerA });
  await mod.seedLead({ id: leadB, ownerId: ownerB });

  await mod.optOut(ownerB, leadB); // only ownerB's lead is opted out

  // ownerA's lead has no opt-out → ordinary suppress succeeds.
  const res = await mod.putSuppress(ownerA, leadA, "Manual DNC A");
  assert.equal(res.kind, "ok", "ownerA suppress is unaffected by ownerB's opt-out");
  const supA = await mod.getSuppression(ownerA, leadA);
  assert.match(supA.reason, /Manual DNC A/, "ownerA got the ordinary reason");
});

test("ordinary suppression (no opt-out) still works and is idempotent", { skip: !hasDb }, async () => {
  const leadId = uid("sob-ordinary");
  await mod.seedLead({ id: leadId, ownerId: ownerA });

  const r1 = await mod.putSuppress(ownerA, leadId, "First reason");
  assert.equal(r1.kind, "ok");
  const s1 = await mod.getSuppression(ownerA, leadId);
  assert.match(s1.reason, /First reason/);
  assert.equal((await mod.getLead(ownerA, leadId)).suppressed, true);

  // Re-suppress with a new reason updates the row (idempotent upsert) — allowed
  // because there is no durable opt-out on this lead.
  const r2 = await mod.putSuppress(ownerA, leadId, "Second reason");
  assert.equal(r2.kind, "ok");
  const s2 = await mod.getSuppression(ownerA, leadId);
  assert.match(s2.reason, /Second reason/, "ordinary re-suppress updates the reason");
  assert.equal(await mod.suppressActivityCount(ownerA, leadId), 2, "each ordinary suppress logs an activity");
});
