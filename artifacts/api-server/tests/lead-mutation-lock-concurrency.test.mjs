/**
 * Lead-mutation lock concurrency — DATABASE-BACKED (Task #33).
 *
 * Proves the unified per-(owner,lead) SESSION advisory lock actually serializes
 * EVERY existing-lead mutation that can change DNC / recipient / facts /
 * eligibility with an in-flight Gmail draft attempt, using REAL Postgres with
 * two independent scoped connections (each withLeadMutationLock checks out its
 * own pool client, exactly as the routes do).
 *
 * Covers:
 *  1. While a simulated Gmail attempt HOLDS the lock, a second holder for the
 *     SAME (owner,lead) cannot enter until the first releases — this is what
 *     stops PATCH/suppress/unsuppress/prospect from interleaving with Gmail.
 *  2. A different (owner,lead) is NOT blocked (owner+lead scoping).
 *  3. The Gmail-style preflight (findOutreachBlock) FAILS CLOSED when the lead
 *     is suppressed OR has a durable outreach opt-out — no provider POST.
 *  4. No deadlock when the owner-duplicate xact lock is taken INNER under the
 *     lead lock (ordering lead-lock → owner-xact-lock) by two concurrent
 *     holders for two different leads of the SAME owner.
 *  5. Source/wiring assertions: every named route file goes through the shared
 *     withLeadMutationLock helper and the raw `outreach-lead-...` key template
 *     lives ONLY in the shared module.
 *
 * NEVER performs a real Gmail POST. Skips gracefully without DATABASE_URL.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);

const outputDir = await mkdtemp(join(tmpdir(), "siteforge-lead-lock-"));
const outFile = join(outputDir, "lead-lock-entry.mjs");

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
      } from "@workspace/db";
      import { withLeadMutationLock } from "./src/lib/lead-mutation-lock.ts";
      import { acquireOwnerDuplicateLock } from "./src/lib/lead-advisory-lock.ts";
      import { findOutreachBlock, applyOutreachOptOut } from "./src/routes/lead-acquisition/outreach-ops.ts";

      export async function seedOwner(id) {
        await db.insert(siteforgeUsersTable).values({ id, email: id + "@test.local" }).onConflictDoNothing();
      }

      export async function seedLead(l) {
        await db.insert(leadsTable).values({
          id: l.id, ownerId: l.ownerId,
          businessName: l.businessName ?? "Test Biz",
          email: l.email ?? "buyer@example.com",
          pipelineStatus: l.pipelineStatus ?? "new",
          websiteStatus: l.websiteStatus ?? "unknown",
          suppressed: l.suppressed ?? false,
        });
      }

      // Acquire the shared lead lock and hold it until the returned release() is
      // called. Resolves once the lock IS held (simulating a Gmail attempt that
      // holds the lock across provider I/O). All on its own scoped connection.
      export async function holdLock(ownerId, leadId) {
        let release;
        const held = new Promise((r) => { release = r; });
        let acquired;
        const acquiredP = new Promise((r) => { acquired = r; });
        const done = withLeadMutationLock(ownerId, leadId, async () => {
          acquired();
          await held; // hold until test signals release
        });
        await acquiredP;
        return { release: () => release(), done };
      }

      // Try to enter the SAME lock and mark whether it entered within timeoutMs.
      // Returns { entered:boolean, finish:Promise } — finish resolves after the
      // lock is actually obtained (used to prove it enters AFTER release).
      export async function tryEnter(ownerId, leadId, timeoutMs) {
        let entered = false;
        const finish = withLeadMutationLock(ownerId, leadId, async () => {
          entered = true;
          return true;
        });
        const timed = await Promise.race([
          finish.then(() => "done"),
          new Promise((r) => setTimeout(() => r("timeout"), timeoutMs)),
        ]);
        return { enteredBeforeTimeout: timed === "done" && entered, finish };
      }

      // Simulated Gmail preflight: re-read the lead + block state under the lock
      // and return the block reason (or null). Mirrors the route's fail-closed
      // preflight. NEVER performs a provider POST.
      export async function gmailPreflight(ownerId, leadId) {
        return withLeadMutationLock(ownerId, leadId, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            const [lead] = await tx.select().from(leadsTable)
              .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId))).limit(1);
            if (!lead) return "not_found";
            const block = await findOutreachBlock(tx, ownerId, lead);
            return block; // string reason, or null = would proceed to POST
          }),
        );
      }

      export async function suppressLead(ownerId, leadId, reason) {
        await db.insert(leadSuppressionsTable).values({
          id: "sup-" + Math.random().toString(16).slice(2),
          leadId, ownerId, reason,
        }).onConflictDoNothing();
        await db.update(leadsTable).set({ suppressed: true })
          .where(and(eq(leadsTable.id, leadId), eq(leadsTable.ownerId, ownerId)));
      }

      export async function optOutLead(ownerId, leadId) {
        // Uses the SAME opt-out helper the routes use (durable opt-out + canonical
        // suppression), inside the shared lock like the opt-out route does.
        return withLeadMutationLock(ownerId, leadId, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            await applyOutreachOptOut(tx, {
              ownerId, leadId, reason: null, channel: null, performedBy: ownerId,
            });
          }),
        );
      }

      // Two concurrent holders for two DIFFERENT leads of the SAME owner, each
      // taking the owner-duplicate xact lock INNER under its lead lock. Proves
      // the lead-lock(outer) → owner-xact-lock(inner) ordering cannot deadlock.
      export async function concurrentOwnerDupLock(ownerId, leadA, leadB) {
        const one = withLeadMutationLock(ownerId, leadA, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            await acquireOwnerDuplicateLock(tx, ownerId);
            await new Promise((r) => setTimeout(r, 40)); // widen the race window
            await tx.select().from(leadsTable).where(eq(leadsTable.id, leadA)).limit(1);
            return "A";
          }),
        );
        const two = withLeadMutationLock(ownerId, leadB, async (lockedDb) =>
          lockedDb.transaction(async (tx) => {
            await acquireOwnerDuplicateLock(tx, ownerId);
            await new Promise((r) => setTimeout(r, 40));
            await tx.select().from(leadsTable).where(eq(leadsTable.id, leadB)).limit(1);
            return "B";
          }),
        );
        return Promise.all([one, two]);
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
    sourcefile: "lead-lock-test-entry.ts",
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

const ownerA = uid("llk-owner-A");
const ownerB = uid("llk-owner-B");

test.after(async () => {
  if (!hasDb) return;
  await mod.cleanupOwner(ownerA);
  await mod.cleanupOwner(ownerB);
  await mod.closePool();
});

test("mutation cannot enter while a simulated Gmail HOLDS the lead lock", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerA);
  const leadId = uid("llk-held");
  await mod.seedLead({ id: leadId, ownerId: ownerA });

  const holder = await mod.holdLock(ownerA, leadId);
  try {
    // A competing mutation (PATCH/suppress/unsuppress/prospect all take this
    // exact lock) must NOT be able to enter while the lock is held.
    const attempt = await mod.tryEnter(ownerA, leadId, 300);
    assert.equal(attempt.enteredBeforeTimeout, false, "second holder must block while Gmail holds the lock");

    // Release; now it must proceed.
    holder.release();
    await holder.done;
    const got = await attempt.finish;
    assert.equal(got, true, "second holder enters only AFTER the Gmail lock is released");
  } finally {
    holder.release();
    await holder.done.catch(() => {});
  }
});

test("a DIFFERENT (owner,lead) is not blocked while the lock is held", { skip: !hasDb }, async () => {
  const leadHeld = uid("llk-otherlead-held");
  const leadFree = uid("llk-otherlead-free");
  await mod.seedLead({ id: leadHeld, ownerId: ownerA });
  await mod.seedLead({ id: leadFree, ownerId: ownerA });

  const holder = await mod.holdLock(ownerA, leadHeld);
  try {
    const attempt = await mod.tryEnter(ownerA, leadFree, 300);
    assert.equal(attempt.enteredBeforeTimeout, true, "a different lead's lock is independent and must not block");
    await attempt.finish;
  } finally {
    holder.release();
    await holder.done.catch(() => {});
  }
});

test("Gmail preflight FAILS CLOSED when the lead is suppressed (no POST)", { skip: !hasDb }, async () => {
  const leadId = uid("llk-suppressed");
  await mod.seedLead({ id: leadId, ownerId: ownerA });

  // Not blocked initially → preflight would proceed to POST.
  assert.equal(await mod.gmailPreflight(ownerA, leadId), null, "eligible lead has no block");

  await mod.suppressLead(ownerA, leadId, "manual DNC");
  const reason = await mod.gmailPreflight(ownerA, leadId);
  assert.ok(typeof reason === "string" && /suppressed/i.test(reason), "suppressed lead is blocked pre-POST");
});

test("Gmail preflight FAILS CLOSED when the lead has a durable outreach opt-out (no POST)", { skip: !hasDb }, async () => {
  const leadId = uid("llk-optout");
  await mod.seedLead({ id: leadId, ownerId: ownerA });
  assert.equal(await mod.gmailPreflight(ownerA, leadId), null);

  await mod.optOutLead(ownerA, leadId);
  const reason = await mod.gmailPreflight(ownerA, leadId);
  assert.ok(typeof reason === "string" && /opted out/i.test(reason), "opted-out lead is blocked pre-POST (opt-out wins)");
});

test("no deadlock: owner-duplicate xact lock taken INNER under two concurrent lead locks", { skip: !hasDb }, async () => {
  await mod.seedOwner(ownerB);
  const leadA = uid("llk-dup-A");
  const leadB = uid("llk-dup-B");
  await mod.seedLead({ id: leadA, ownerId: ownerB });
  await mod.seedLead({ id: leadB, ownerId: ownerB });

  const results = await Promise.race([
    mod.concurrentOwnerDupLock(ownerB, leadA, leadB),
    new Promise((_r, rej) => setTimeout(() => rej(new Error("DEADLOCK: concurrent owner-dup-lock holders did not both complete")), 5000)),
  ]);
  assert.deepEqual([...results].sort(), ["A", "B"], "both holders complete with no deadlock");
});

// ── Source/wiring assertions (no DB required) ─────────────────────────────────

const routeDir = new URL("../src/routes/lead-acquisition/", import.meta.url);
const src = {};
for (const f of ["routes-outreach.ts", "routes-leads.ts", "suppression.ts", "routes-prospect.ts"]) {
  src[f] = await readFile(new URL(f, routeDir), "utf8");
}
const sharedLock = await readFile(new URL("../src/lib/lead-mutation-lock.ts", import.meta.url), "utf8");

test("wiring: the raw lock-key template lives ONLY in the shared module", () => {
  const returned = sharedLock.match(/return `outreach-lead-[^`]*`/g) ?? [];
  assert.equal(returned.length, 1, "shared module returns exactly one canonical key");
  for (const [f, text] of Object.entries(src)) {
    const raw = text.match(/`outreach-lead-[^`]*`/g) ?? [];
    assert.equal(raw.length, 0, `${f} must not hand-roll the lock-key template`);
    assert.doesNotMatch(text, /function outreachLeadLockKey\(/, `${f} must not redefine the key builder`);
  }
});

test("wiring: PATCH /leads/:leadId goes through withLeadMutationLock", () => {
  // Both the direct import and a call site for the PATCH handler.
  assert.match(src["routes-leads.ts"], /import \{ withLeadMutationLock \} from "\.\.\/\.\.\/lib\/lead-mutation-lock"/);
  assert.match(src["routes-leads.ts"], /withLeadMutationLock\(/);
  // The PATCH handler tx must run on the scoped lockedDb, and the owner dup lock
  // is acquired INSIDE that (inner), never on the global db.
  assert.match(src["routes-leads.ts"], /lockedDb\.transaction\(/);
});

test("wiring: PUT and DELETE suppression both go through withLeadMutationLock", () => {
  assert.match(src["suppression.ts"], /import \{ withLeadMutationLock \} from "\.\.\/\.\.\/lib\/lead-mutation-lock"/);
  const uses = (src["suppression.ts"].match(/withLeadMutationLock\(/g) ?? []).length;
  assert.equal(uses, 2, "suppress (PUT) and unsuppress (DELETE) each use the shared lock");
  // No suppression mutation may run on the global db anymore.
  assert.doesNotMatch(src["suppression.ts"], /\bdb\.transaction\(/);
});

test("wiring: BOTH suppression handlers fail closed on a durable opt-out", () => {
  const text = src["suppression.ts"];
  // The durable opt-out guard is used in BOTH PUT and DELETE (2 call sites).
  const guards = (text.match(/hasDurableOutreachOptOut\(/g) ?? []).length;
  assert.equal(guards, 2, "PUT and DELETE each check hasDurableOutreachOptOut");
  // In PUT, the guard MUST run before any suppression write (upsert/update/
  // appendActivity): the opt-out branch appears before the first insert.
  const putIdx = text.indexOf('suppressionRouter.put(');
  const delIdx = text.indexOf('suppressionRouter.delete(');
  const putBody = text.slice(putIdx, delIdx);
  const guardIdx = putBody.indexOf('hasDurableOutreachOptOut(');
  const insertIdx = putBody.indexOf('.insert(leadSuppressionsTable)');
  assert.ok(guardIdx >= 0, "PUT has the opt-out guard");
  assert.ok(insertIdx >= 0 && guardIdx < insertIdx, "PUT opt-out guard runs BEFORE the suppression upsert (fail closed, no write)");
});

test("wiring: prospect fact/pipeline mutations (generate/regenerate/convert) use withLeadMutationLock", () => {
  assert.match(src["routes-prospect.ts"], /import \{ withLeadMutationLock \} from "\.\.\/\.\.\/lib\/lead-mutation-lock"/);
  const uses = (src["routes-prospect.ts"].match(/withLeadMutationLock\(/g) ?? []).length;
  assert.equal(uses, 3, "generate + regenerate + convert each wrap their tx in the shared lock");
});

test("wiring: outreach handlers still converge on the shared lock (via alias)", () => {
  assert.match(src["routes-outreach.ts"], /withLeadMutationLock\(ownerId, leadId, operation, onUnlockFailure\)/);
  // The Gmail provider call remains inside the lock body.
  const gmailIdx = src["routes-outreach.ts"].indexOf("/gmail-draft");
  const after = src["routes-outreach.ts"].slice(gmailIdx);
  const lockOpen = after.indexOf("withOutreachLeadLock(");
  const provider = after.indexOf("createOutreachGmailDraft(connector");
  assert.ok(lockOpen >= 0 && provider > lockOpen, "provider POST stays inside the lock");
});

test("wiring: fail-closed preflight re-reads block state immediately before the provider POST", () => {
  const text = src["routes-outreach.ts"];
  const preflightIdx = text.indexOf("Phase 1b");
  const providerIdx = text.indexOf("createOutreachGmailDraft(connector");
  assert.ok(preflightIdx >= 0, "an explicit pre-POST preflight phase exists");
  assert.ok(preflightIdx < providerIdx, "preflight runs BEFORE the provider POST");
  // The preflight re-reads the block state through findOutreachBlock and fails
  // closed (returns without POST) when blocked/changed.
  const preflightBlock = text.slice(preflightIdx, providerIdx);
  assert.match(preflightBlock, /findOutreachBlock\(/, "preflight re-checks findOutreachBlock");
  assert.match(preflightBlock, /if \(!preflight\.ok\)/, "preflight fails closed before POST");
});
