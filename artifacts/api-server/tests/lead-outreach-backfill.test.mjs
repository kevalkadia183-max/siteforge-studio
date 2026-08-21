/**
 * Migration 0009 — outreach opt-out → canonical DNC backfill (DB-backed).
 *
 * Proves the forward, data-only backfill migration
 * (lib/db/drizzle/0009_backfill_outreach_optout_suppressions.sql) correctly
 * upgrades PRE-EXISTING optout-only data (rows written before the round-5 fix,
 * which never propagated to the canonical model) into the canonical DNC model:
 *   - lead_acquisition_suppressions upserted with an honest opt-out reason and a
 *     deterministic, collision-safe text id,
 *   - lead_acquisition_leads.suppressed = TRUE,
 *   - owner scoping preserved,
 *   - re-applying the migration is a no-op (idempotent).
 *
 * The test executes the ACTUAL migration SQL read from disk (comments stripped,
 * split on the drizzle statement-breakpoint marker), so it is a true test of the
 * shipped migration rather than a reimplementation. Fixtures use unique ids and
 * are cleaned up. Skips gracefully when no DATABASE_URL is configured.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);

// ─── Load the real migration SQL and split into executable statements ────────
const migrationPath = fileURLToPath(
  new URL(
    "../../../lib/db/drizzle/0009_backfill_outreach_optout_suppressions.sql",
    import.meta.url,
  ),
);
const migrationSql = readFileSync(migrationPath, "utf8");
const migrationStatements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.replace(/--[^\n]*\n/g, "\n").trim())
  .filter((s) => s.length > 0);

// Structural guardrails on the migration itself (run even without a DB).
test("0009 is registered in the drizzle meta journal with a snapshot", () => {
  const journal = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../lib/db/drizzle/meta/_journal.json", import.meta.url)),
      "utf8",
    ),
  );
  const entry = journal.entries.find(
    (e) => e.tag === "0009_backfill_outreach_optout_suppressions",
  );
  assert.ok(entry, "0009 registered in journal");
  assert.equal(entry.idx, 9, "0009 has idx 9");
  const snap = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../lib/db/drizzle/meta/0009_snapshot.json", import.meta.url)),
      "utf8",
    ),
  );
  assert.equal(snap.dialect, "postgresql");
});

test("0009 SQL is data-only, idempotent-shaped, and honest", () => {
  assert.equal(migrationStatements.length, 2, "two statements: suppression upsert + lead flag");
  // No DDL — this migration must not alter schema.
  assert.doesNotMatch(migrationSql, /\b(CREATE|DROP|ALTER)\s+TABLE\b/i, "no table DDL");
  // Idempotent upsert on the canonical unique key.
  assert.match(migrationSql, /ON CONFLICT \("lead_id", "owner_id"\) DO UPDATE/i);
  // Deterministic, namespaced, collision-safe id.
  assert.match(migrationSql, /'optout-supp-' \|\| md5\('lead_acquisition_outreach_optout:'/i);
  // Honest reason wording mirrors the application.
  assert.match(migrationSql, /'Outreach opt-out: '/);
  assert.match(migrationSql, /'Outreach opt-out'/);
  // Owner-scoped lead join.
  assert.match(migrationSql, /l\."owner_id" = o\."owner_id"/i);
});

// Deterministic id the migration computes, recomputed in JS for assertions.
function expectedSuppressionId(ownerId, leadId) {
  const hash = createHash("md5")
    .update(`lead_acquisition_outreach_optout:${ownerId}:${leadId}`)
    .digest("hex");
  return `optout-supp-${hash}`;
}

// ─── DB-backed backfill behavior ─────────────────────────────────────────────
if (hasDb) {
  const outputDir = await mkdtemp(join(tmpdir(), "siteforge-backfill-"));
  const outFile = join(outputDir, "backfill-entry.mjs");
  await build({
    stdin: {
      contents: `
        import { and, eq, sql } from "drizzle-orm";
        import {
          db,
          pool,
          siteforgeUsersTable,
          leadsTable,
          leadSuppressionsTable,
          leadOutreachOptOutsTable,
        } from "@workspace/db";

        export async function seedOwner(id) {
          await db.insert(siteforgeUsersTable).values({ id, email: id + "@test.local" }).onConflictDoNothing();
        }
        export async function seedLead(l) {
          await db.insert(leadsTable).values({
            id: l.id, ownerId: l.ownerId, businessName: l.businessName,
            suppressed: l.suppressed ?? false, pipelineStatus: "qualified",
          });
        }
        export async function seedOptOut(o) {
          await db.insert(leadOutreachOptOutsTable).values({
            id: o.id, ownerId: o.ownerId, leadId: o.leadId,
            reason: o.reason ?? null, channel: o.channel ?? null,
          });
        }
        export async function runMigration(statements) {
          for (const s of statements) {
            await db.execute(sql.raw(s));
          }
        }
        export async function getSuppression(ownerId, leadId) {
          const [r] = await db.select().from(leadSuppressionsTable)
            .where(and(eq(leadSuppressionsTable.ownerId, ownerId), eq(leadSuppressionsTable.leadId, leadId))).limit(1);
          return r ?? null;
        }
        export async function countSuppressions(ownerId, leadId) {
          const rows = await db.select({ id: leadSuppressionsTable.id }).from(leadSuppressionsTable)
            .where(and(eq(leadSuppressionsTable.ownerId, ownerId), eq(leadSuppressionsTable.leadId, leadId)));
          return rows.length;
        }
        export async function getLead(ownerId, leadId) {
          const [r] = await db.select().from(leadsTable)
            .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1);
          return r ?? null;
        }
        export async function cleanupOwner(ownerId) {
          const leads = await db.select({ id: leadsTable.id }).from(leadsTable).where(eq(leadsTable.ownerId, ownerId));
          for (const l of leads) {
            await db.delete(leadOutreachOptOutsTable).where(eq(leadOutreachOptOutsTable.leadId, l.id));
            await db.delete(leadSuppressionsTable).where(eq(leadSuppressionsTable.leadId, l.id));
          }
          await db.delete(leadsTable).where(eq(leadsTable.ownerId, ownerId));
          await db.delete(siteforgeUsersTable).where(eq(siteforgeUsersTable.id, ownerId));
        }
        export async function closePool() { await pool.end(); }
      `,
      resolveDir: new URL("..", import.meta.url).pathname,
      sourcefile: "backfill-test-entry.ts",
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
  const ownerA = uid("bf-owner-A");
  const ownerB = uid("bf-owner-B");

  test.after(async () => {
    await mod.cleanupOwner(ownerA);
    await mod.cleanupOwner(ownerB);
    await mod.closePool();
  });

  test("backfill: pre-existing optout-only data becomes canonical (with reason)", async () => {
    await mod.seedOwner(ownerA);
    const leadId = uid("bf-lead");
    // Simulate the pre-fix state: opt-out row exists, but NO suppression and
    // leads.suppressed is still false.
    await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Legacy OptOut Co", suppressed: false });
    await mod.seedOptOut({ id: uid("oo"), ownerId: ownerA, leadId, reason: "unsubscribed via link", channel: "email" });

    assert.equal(await mod.getSuppression(ownerA, leadId), null, "no suppression before backfill");
    assert.equal((await mod.getLead(ownerA, leadId)).suppressed, false, "lead not suppressed before backfill");

    await mod.runMigration(migrationStatements);

    const supp = await mod.getSuppression(ownerA, leadId);
    assert.ok(supp, "canonical suppression created");
    assert.equal(supp.id, expectedSuppressionId(ownerA, leadId), "deterministic collision-safe id");
    assert.equal(supp.reason, "Outreach opt-out: unsubscribed via link", "honest reason with detail");
    assert.equal((await mod.getLead(ownerA, leadId)).suppressed, true, "leads.suppressed flipped true");
  });

  test("backfill: opt-out without a reason gets the bare honest reason", async () => {
    const leadId = uid("bf-noreason");
    await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "No Reason Co", suppressed: false });
    await mod.seedOptOut({ id: uid("oo"), ownerId: ownerA, leadId, reason: null, channel: null });

    await mod.runMigration(migrationStatements);

    const supp = await mod.getSuppression(ownerA, leadId);
    assert.ok(supp);
    assert.equal(supp.reason, "Outreach opt-out", "bare honest reason when opt-out has none");
    assert.equal((await mod.getLead(ownerA, leadId)).suppressed, true);
  });

  test("backfill: idempotent reapplication does not duplicate or corrupt rows", async () => {
    const leadId = uid("bf-idem");
    await mod.seedLead({ id: leadId, ownerId: ownerA, businessName: "Idempotent Co", suppressed: false });
    await mod.seedOptOut({ id: uid("oo"), ownerId: ownerA, leadId, reason: "stop", channel: "email" });

    await mod.runMigration(migrationStatements);
    const first = await mod.getSuppression(ownerA, leadId);
    await mod.runMigration(migrationStatements); // reapply

    assert.equal(await mod.countSuppressions(ownerA, leadId), 1, "still exactly one suppression row");
    const second = await mod.getSuppression(ownerA, leadId);
    assert.equal(second.id, first.id, "same deterministic id on reapply");
    assert.equal(second.reason, "Outreach opt-out: stop", "reason unchanged");
    assert.equal((await mod.getLead(ownerA, leadId)).suppressed, true);
  });

  test("backfill: owner scoping — a different owner's lead is untouched", async () => {
    await mod.seedOwner(ownerB);
    const leadA = uid("bf-iso-A");
    const leadB = uid("bf-iso-B"); // ownerB lead with NO opt-out
    await mod.seedLead({ id: leadA, ownerId: ownerA, businessName: "Iso Co", suppressed: false });
    await mod.seedLead({ id: leadB, ownerId: ownerB, businessName: "Iso Co", suppressed: false });
    await mod.seedOptOut({ id: uid("oo"), ownerId: ownerA, leadId: leadA, reason: "A only", channel: null });

    await mod.runMigration(migrationStatements);

    assert.ok(await mod.getSuppression(ownerA, leadA), "ownerA opted-out lead suppressed");
    assert.equal(await mod.getSuppression(ownerB, leadB), null, "ownerB (no opt-out) has no suppression");
    assert.equal((await mod.getLead(ownerB, leadB)).suppressed, false, "ownerB lead not flipped");
  });
}
