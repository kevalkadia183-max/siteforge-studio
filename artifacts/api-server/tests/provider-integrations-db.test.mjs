/**
 * Provider integrations — database-backed owner isolation and quota coverage.
 *
 * Skips gracefully when DATABASE_URL is unavailable.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const hasDb = Boolean(process.env.DATABASE_URL);
const outputDir = await mkdtemp(join(tmpdir(), "siteforge-provider-db-"));
const outFile = join(outputDir, "provider-db-entry.mjs");

await build({
  stdin: {
    contents: `
      import { eq } from "drizzle-orm";
      import {
        db,
        pool,
        siteforgeUsersTable,
        providerSettingsTable,
        providerAuditEventsTable,
        providerQuotaWindowsTable,
      } from "@workspace/db";
      import {
        appendProviderAuditEvent,
        consumeQuotaAtomic,
        getCapabilitySettings,
        updateCapabilitySettings,
      } from "./src/lib/provider-operations.ts";
      import { UpdateProviderSettingBody } from "@workspace/api-zod";

      export {
        appendProviderAuditEvent,
        consumeQuotaAtomic,
        getCapabilitySettings,
        updateCapabilitySettings,
      };

      export function validateProviderSettingBody(value) {
        return UpdateProviderSettingBody.safeParse(value).success;
      }

      export async function seedOwner(id) {
        await db
          .insert(siteforgeUsersTable)
          .values({ id, email: id + "@test.local" })
          .onConflictDoNothing();
      }

      export async function getQuotaRows(ownerId) {
        return db
          .select()
          .from(providerQuotaWindowsTable)
          .where(eq(providerQuotaWindowsTable.ownerId, ownerId));
      }

      export async function getAuditRows(ownerId) {
        return db
          .select()
          .from(providerAuditEventsTable)
          .where(eq(providerAuditEventsTable.ownerId, ownerId));
      }

      export async function cleanupOwner(ownerId) {
        await db
          .delete(providerAuditEventsTable)
          .where(eq(providerAuditEventsTable.ownerId, ownerId));
        await db
          .delete(providerQuotaWindowsTable)
          .where(eq(providerQuotaWindowsTable.ownerId, ownerId));
        await db
          .delete(providerSettingsTable)
          .where(eq(providerSettingsTable.ownerId, ownerId));
        await db
          .delete(siteforgeUsersTable)
          .where(eq(siteforgeUsersTable.id, ownerId));
      }

      export async function closePool() {
        await pool.end();
      }
    `,
    resolveDir: new URL("..", import.meta.url).pathname,
    sourcefile: "provider-db-test-entry.ts",
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

const ownerA = uid("provider-owner-A");
const ownerB = uid("provider-owner-B");

test.after(async () => {
  if (!hasDb) return;
  await mod.cleanupOwner(ownerA);
  await mod.cleanupOwner(ownerB);
  await mod.closePool();
});

test(
  "provider settings and audit events remain owner-scoped",
  { skip: !hasDb },
  async () => {
    await mod.seedOwner(ownerA);
    await mod.seedOwner(ownerB);

    await mod.updateCapabilitySettings(ownerA, "email", { enabled: false });

    const [settingsA, settingsB, auditA, auditB] = await Promise.all([
      mod.getCapabilitySettings(ownerA, "email"),
      mod.getCapabilitySettings(ownerB, "email"),
      mod.getAuditRows(ownerA),
      mod.getAuditRows(ownerB),
    ]);

    assert.equal(settingsA.enabled, false);
    assert.equal(settingsA.availability, "disabled");
    assert.equal(settingsB.enabled, true);
    assert.equal(settingsB.availability, "available");
    assert.equal(auditA.length, 1);
    assert.equal(auditA[0].capability, "email");
    assert.equal(auditA[0].eventType, "settings_updated");
    assert.equal(auditB.length, 0);
  },
);

test("provider settings contract rejects an empty update body", () => {
  assert.equal(mod.validateProviderSettingBody({}), false);
  assert.equal(mod.validateProviderSettingBody({ enabled: false }), true);
  assert.equal(
    mod.validateProviderSettingBody({
      config: { requireExplicitConsent: true },
    }),
    true,
  );
  assert.equal(
    mod.validateProviderSettingBody({
      enabled: false,
      config: { requireExplicitConsent: true },
    }),
    true,
  );
});

test(
  "provider audit persistence rejects secret-bearing detail keys",
  { skip: !hasDb },
  async () => {
    await mod.seedOwner(ownerB);
    await assert.rejects(
      () =>
        mod.appendProviderAuditEvent({
          ownerId: ownerB,
          capability: "discovery",
          providerKey: "test-provider",
          eventType: "unsafe_test",
          outcome: "failure",
          detail: { accessToken: "must-not-be-persisted" },
        }),
      /forbidden key/i,
    );
    assert.equal((await mod.getAuditRows(ownerB)).length, 0);
  },
);

test(
  "atomic quota consumption never exceeds the configured limit",
  { skip: !hasDb },
  async () => {
    await mod.seedOwner(ownerA);
    const windowStart = new Date();
    windowStart.setMilliseconds(0);
    const windowEndsAt = new Date(windowStart.getTime() + 60_000);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        mod.consumeQuotaAtomic({
          ownerId: ownerA,
          capability: "discovery",
          providerKey: "quota-test-provider",
          windowStart,
          windowEndsAt,
          limit: 2,
        }),
      ),
    );

    assert.equal(
      attempts.filter((attempt) => attempt.consumed).length,
      2,
    );

    const rows = await mod.getQuotaRows(ownerA);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used, 2);
    assert.equal(rows[0].limit, 2);
  },
);