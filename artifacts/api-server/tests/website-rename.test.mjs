/**
 * Tests for PATCH /websites/:websiteId rename semantics.
 *
 * All tests are pure (no DB / HTTP) using an extracted decision helper that
 * mirrors the transactional rename logic in routes/websites/index.ts.
 *
 * Contract requirements verified:
 * 1. expectedRevision is required — missing body field is invalid
 * 2. Correct revision → name updated on BOTH row.name and projectSource.name, revision incremented
 * 3. Stale revision → 409 with current record in response body
 * 4. Future revision → 409 (also stale from the DB's perspective)
 * 5. Owner isolation — another user's websiteId is not found
 * 6. Concurrent stale full-save after rename sees revision mismatch (can't overwrite)
 * 7. RenameWebsiteBody schema rejects missing expectedRevision
 * 8. RenameWebsiteBody schema rejects missing name
 * 9. RenameWebsiteBody schema accepts valid {name, expectedRevision}
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// ─── Build api-zod for Zod schema tests ───────────────────────────────────
const outputDir = await mkdtemp(join(tmpdir(), "siteforge-rename-"));
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
const { RenameWebsiteBody } = await import(pathToFileURL(zodOut).href);

// ─── Pure rename decision helper (mirrors route transaction logic) ─────────

/**
 * Simulate the transactional rename logic without a real DB.
 *
 * @param {object} store   Map of `${ownerId}:${id}` → website row
 * @param {string} ownerId Authenticated user
 * @param {string} id      Website ID
 * @param {string} newName New name
 * @param {number} expectedRevision Client's revision expectation
 * @returns {{ kind: "updated", website } | { kind: "conflict", current } | { kind: "not_found" }}
 */
function simulateRename(store, ownerId, id, newName, expectedRevision) {
  const key = `${ownerId}:${id}`;
  const current = store.get(key);

  if (!current) return { kind: "not_found" };

  if (current.revision !== expectedRevision) {
    return { kind: "conflict", current: { ...current } };
  }

  // Update BOTH canonical name and projectSource.name, increment revision
  const updatedSource = { ...(current.projectSource ?? {}), name: newName };
  const updated = {
    ...current,
    name: newName,
    projectSource: updatedSource,
    revision: current.revision + 1,
  };
  store.set(key, updated);
  return { kind: "updated", website: updated };
}

function makeWebsite(overrides = {}) {
  return {
    ownerId: "user-alice",
    id: "site-001",
    name: "Old Name",
    projectSource: { id: "proj-1", name: "Old Name", createdAt: 1000, updatedAt: 1001 },
    settings: {},
    revision: 5,
    status: "active",
  };
}

// ─── Schema contract tests ─────────────────────────────────────────────────

test("RenameWebsiteBody rejects missing expectedRevision", () => {
  const result = RenameWebsiteBody.safeParse({ name: "New Name" });
  assert.ok(!result.success, "should reject body without expectedRevision");
  const paths = result.error.issues.map((i) => i.path.join("."));
  assert.ok(
    paths.some((p) => p.includes("expectedRevision")),
    `expected error on expectedRevision, got: ${paths.join(", ")}`,
  );
});

test("RenameWebsiteBody rejects missing name", () => {
  const result = RenameWebsiteBody.safeParse({ expectedRevision: 5 });
  assert.ok(!result.success, "should reject body without name");
  const paths = result.error.issues.map((i) => i.path.join("."));
  assert.ok(
    paths.some((p) => p.includes("name")),
    `expected error on name, got: ${paths.join(", ")}`,
  );
});

test("RenameWebsiteBody accepts valid {name, expectedRevision}", () => {
  const result = RenameWebsiteBody.safeParse({ name: "New Name", expectedRevision: 5 });
  assert.ok(result.success, "valid body should parse");
  if (result.success) {
    assert.equal(result.data.name, "New Name");
    assert.equal(result.data.expectedRevision, 5);
  }
});

test("RenameWebsiteBody rejects negative expectedRevision", () => {
  const result = RenameWebsiteBody.safeParse({ name: "New", expectedRevision: -1 });
  assert.ok(!result.success, "negative expectedRevision must be rejected");
});

test("RenameWebsiteBody rejects empty name", () => {
  const result = RenameWebsiteBody.safeParse({ name: "", expectedRevision: 0 });
  assert.ok(!result.success, "empty name must be rejected");
});

// ─── Rename policy tests ───────────────────────────────────────────────────

test("correct revision → both row.name and projectSource.name updated, revision incremented", () => {
  const store = new Map();
  const website = makeWebsite();
  store.set(`${website.ownerId}:${website.id}`, website);

  const result = simulateRename(store, "user-alice", "site-001", "New Name", 5);

  assert.equal(result.kind, "updated");
  assert.equal(result.website.name, "New Name", "row.name updated");
  assert.equal(result.website.projectSource.name, "New Name", "projectSource.name updated");
  assert.equal(result.website.revision, 6, "revision incremented");

  // Verify stored row also updated
  const stored = store.get("user-alice:site-001");
  assert.equal(stored.name, "New Name");
  assert.equal(stored.projectSource.name, "New Name");
  assert.equal(stored.revision, 6);
});

test("stale revision → 409 conflict with current record", () => {
  const store = new Map();
  const website = makeWebsite(); // revision = 5
  store.set(`${website.ownerId}:${website.id}`, website);

  const result = simulateRename(store, "user-alice", "site-001", "New Name", 4); // stale: 4 ≠ 5

  assert.equal(result.kind, "conflict", "stale revision must yield conflict");
  assert.equal(result.current.revision, 5, "conflict includes current revision");
  assert.equal(result.current.name, "Old Name", "conflict includes current name");

  // Original row must NOT be modified
  const stored = store.get("user-alice:site-001");
  assert.equal(stored.name, "Old Name", "row.name unchanged after conflict");
  assert.equal(stored.revision, 5, "revision unchanged after conflict");
});

test("future revision → 409 conflict (also stale from DB perspective)", () => {
  const store = new Map();
  const website = makeWebsite(); // revision = 5
  store.set(`${website.ownerId}:${website.id}`, website);

  const result = simulateRename(store, "user-alice", "site-001", "New Name", 99); // future

  assert.equal(result.kind, "conflict", "future revision is also a conflict");
  assert.equal(result.current.revision, 5);
});

test("not-found website → 404", () => {
  const store = new Map(); // empty

  const result = simulateRename(store, "user-alice", "nonexistent", "New Name", 0);

  assert.equal(result.kind, "not_found");
});

test("owner isolation — another user cannot rename alice's website", () => {
  const store = new Map();
  const website = makeWebsite(); // ownerId = "user-alice"
  store.set(`${website.ownerId}:${website.id}`, website);

  // Bob tries to rename with the correct revision
  const result = simulateRename(store, "user-bob", "site-001", "Hijacked Name", 5);

  assert.equal(result.kind, "not_found", "cross-owner access must return not_found");

  // Alice's website must be untouched
  const stored = store.get("user-alice:site-001");
  assert.equal(stored.name, "Old Name", "alice's website name unchanged");
});

test("concurrent stale full-save after rename sees revision mismatch and cannot overwrite", () => {
  const store = new Map();
  const website = makeWebsite(); // revision = 5
  store.set(`${website.ownerId}:${website.id}`, website);

  // Rename succeeds: revision 5 → 6, both names updated
  const rename = simulateRename(store, "user-alice", "site-001", "Renamed", 5);
  assert.equal(rename.kind, "updated");
  assert.equal(store.get("user-alice:site-001").revision, 6);

  // Concurrent full-save was prepared against revision 5 (stale) — simulates
  // checkRevision logic from PUT /websites/:id
  function simulateSave(store, ownerId, id, expectedRevision, newProjectSource) {
    const key = `${ownerId}:${id}`;
    const current = store.get(key);
    if (!current) return { kind: "not_found" };
    if (current.revision !== expectedRevision) return { kind: "conflict", current: { ...current } };
    const updated = { ...current, projectSource: newProjectSource, revision: current.revision + 1 };
    store.set(key, updated);
    return { kind: "updated", website: updated };
  }

  // The stale full-save carries expectedRevision: 5, but row is now at 6
  const save = simulateSave(
    store,
    "user-alice",
    "site-001",
    5, // stale — was prepared before the rename
    { id: "proj-1", name: "Old Name", createdAt: 1000, updatedAt: 9999 },
  );

  assert.equal(save.kind, "conflict", "stale full-save after rename must conflict");
  assert.equal(save.current.revision, 6, "current revision from conflict is 6 (post-rename)");
  assert.equal(save.current.name, "Renamed", "conflict shows the renamed name");

  // Store still has the renamed version
  const stored = store.get("user-alice:site-001");
  assert.equal(stored.name, "Renamed", "rename result persists, not overwritten by stale save");
  assert.equal(stored.revision, 6);
});

test("revision 0 is a valid expectedRevision for brand-new websites", () => {
  const store = new Map();
  const website = { ...makeWebsite(), revision: 0 };
  store.set(`${website.ownerId}:${website.id}`, website);

  const result = simulateRename(store, "user-alice", "site-001", "First Rename", 0);

  assert.equal(result.kind, "updated");
  assert.equal(result.website.revision, 1);
  assert.equal(result.website.name, "First Rename");
});
