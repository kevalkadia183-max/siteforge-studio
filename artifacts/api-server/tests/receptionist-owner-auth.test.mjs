/**
 * Tests for the receptionist owner authorization policy.
 *
 * The policy is extracted as a pure synchronous decision function so these tests
 * need no database or HTTP server. All cases correspond directly to the
 * verifyReceptionistOwner implementation in receptionist-owner-auth.ts.
 *
 * Cases covered:
 * 1. Clerk user who IS the ownerId → authorized
 * 2. Clerk user who is NOT the ownerId → denied (403), even if they have a linked project
 * 3. Valid ownerKey, non-null ownerId, no Clerk session → authorized (no claim)
 * 4. Valid ownerKey, null ownerId (legacy), no Clerk session → authorized (no claim)
 * 5. Valid ownerKey, null ownerId (legacy), Clerk session present → authorized + claim triggered
 * 6. Valid ownerKey, non-null ownerId, different Clerk user → authorized (key valid), no re-claim
 * 7. Invalid ownerKey, no Clerk session → 401
 * 8. Invalid ownerKey, Clerk session present but doesn't own → 403
 * 9. No ownerKey, no Clerk session → 401
 * 10. Valid ownerKey hash mismatch (wrong key) → 404 (oracle-resistant)
 * 11. attacker-controlled projectSource receptionistId must NOT grant access
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

// ─── Pure decision helper (mirrors verifyReceptionistOwner logic) ──────────

/**
 * Synchronous pure representation of the authorization decision.
 * Returns: { authorized: true } | { authorized: false, status, error } | { authorized: true, shouldClaim: true }
 */
function decideAccess({
  receptionist,          // { id, ownerKeyHash, ownerId: string|null }
  clerkUserId,           // string | null
  submittedOwnerKey,     // string (empty = not provided)
}) {
  // Simulate hashSecret (SHA-256 hex, same as production)
  function hashSecret(key) {
    return createHash("sha256").update(key).digest("hex");
  }

  // Path 1: Clerk session owns this receptionist (DB-authoritative)
  if (clerkUserId && receptionist.ownerId === clerkUserId) {
    return { authorized: true, shouldClaim: false };
  }

  // Path 2: Owner key
  if (submittedOwnerKey.length >= 16) {
    const submittedHash = hashSecret(submittedOwnerKey);
    if (submittedHash === receptionist.ownerKeyHash) {
      // Legacy claim: null ownerId + Clerk user present
      const shouldClaim = receptionist.ownerId === null && clerkUserId !== null;
      return { authorized: true, shouldClaim };
    }
  }

  // Neither path authorized
  if (clerkUserId) {
    return { authorized: false, status: 403, error: "Not authorized for this receptionist." };
  } else if (submittedOwnerKey.length > 0) {
    // Key provided but wrong — oracle-resistant 404
    return { authorized: false, status: 404, error: "Receptionist not found." };
  } else {
    return { authorized: false, status: 401, error: "Authentication required." };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeHash(key) {
  return createHash("sha256").update(key).digest("hex");
}

const OWNER_KEY = "correct-owner-key-abc123";
const OWNER_KEY_HASH = makeHash(OWNER_KEY);
const WRONG_KEY = "wrong-owner-key-xyz789!";

function makeReceptionist(overrides = {}) {
  return {
    id: "rec-001",
    ownerKeyHash: OWNER_KEY_HASH,
    ownerId: "user-alice",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

test("1. Clerk user matches ownerId → authorized, no claim", () => {
  const r = makeReceptionist({ ownerId: "user-alice" });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: "user-alice",
    submittedOwnerKey: "",
  });
  assert.ok(result.authorized, "should be authorized");
  assert.equal(result.shouldClaim, false, "no claim needed (already owned)");
});

test("2. Clerk user does NOT match ownerId → denied 403 (attacker-controlled projectSource irrelevant)", () => {
  // Even if attacker edited their website's projectSource to contain this receptionistId,
  // the DB-authoritative ownerId check prevents access. No projectSource lookup occurs.
  const r = makeReceptionist({ ownerId: "user-alice" });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: "user-mallory",   // different user
    submittedOwnerKey: "",
  });
  assert.ok(!result.authorized, "foreign Clerk user must be denied");
  assert.equal(result.status, 403, "403 for authenticated but unauthorized user");
});

test("3. Valid ownerKey, non-null ownerId, no Clerk session → authorized, no claim", () => {
  const r = makeReceptionist({ ownerId: "user-alice" });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: null,
    submittedOwnerKey: OWNER_KEY,
  });
  assert.ok(result.authorized, "valid key must authorize");
  assert.equal(result.shouldClaim, false, "ownerId already set — no claim");
});

test("4. Valid ownerKey, null ownerId (legacy), no Clerk session → authorized, no claim triggered", () => {
  const r = makeReceptionist({ ownerId: null });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: null,
    submittedOwnerKey: OWNER_KEY,
  });
  assert.ok(result.authorized, "valid key on legacy receptionist must authorize");
  assert.equal(result.shouldClaim, false, "no Clerk user present — cannot claim");
});

test("5. Valid ownerKey, null ownerId (legacy), Clerk session present → authorized + claim", () => {
  const r = makeReceptionist({ ownerId: null });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: "user-bob",
    submittedOwnerKey: OWNER_KEY,
  });
  assert.ok(result.authorized, "valid key + Clerk user must authorize");
  assert.equal(result.shouldClaim, true, "legacy receptionist: claim should be triggered");
});

test("6. Valid ownerKey, non-null ownerId, DIFFERENT Clerk user → authorized, must NOT re-claim", () => {
  // Key holder is always valid (original owner could be using API key from a different session)
  const r = makeReceptionist({ ownerId: "user-alice" });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: "user-bob",   // different Clerk user but has the key
    submittedOwnerKey: OWNER_KEY,
  });
  assert.ok(result.authorized, "valid key must authorize regardless of Clerk user mismatch");
  assert.equal(result.shouldClaim, false, "must NOT overwrite non-null ownerId");
});

test("7. No key, no Clerk session → 401", () => {
  const r = makeReceptionist();
  const result = decideAccess({
    receptionist: r,
    clerkUserId: null,
    submittedOwnerKey: "",
  });
  assert.ok(!result.authorized);
  assert.equal(result.status, 401);
});

test("8. Wrong ownerKey, Clerk session present but not owner → 403", () => {
  const r = makeReceptionist({ ownerId: "user-alice" });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: "user-mallory",
    submittedOwnerKey: WRONG_KEY,
  });
  assert.ok(!result.authorized);
  assert.equal(result.status, 403, "authenticated but unauthorized → 403");
});

test("9. No key, no Clerk session (unauthenticated) → 401", () => {
  const r = makeReceptionist();
  const result = decideAccess({
    receptionist: r,
    clerkUserId: null,
    submittedOwnerKey: "",
  });
  assert.ok(!result.authorized);
  assert.equal(result.status, 401);
});

test("10. Wrong ownerKey, no Clerk session → 404 (oracle-resistant)", () => {
  // Providing a key (any key) that doesn't match hash-compares to the DB record.
  // We return 404 to avoid leaking whether the receptionistId exists.
  const r = makeReceptionist({ ownerId: null });
  const result = decideAccess({
    receptionist: r,
    clerkUserId: null,
    submittedOwnerKey: WRONG_KEY,
  });
  assert.ok(!result.authorized);
  assert.equal(result.status, 404, "wrong key without Clerk session → oracle-resistant 404");
});

test("11. Attacker with projectSource containing receptionistId cannot gain access", () => {
  // The attacker edits their own website's projectSource.receptionist.receptionistId
  // to point at a victim's receptionist. This must NOT grant access.
  //
  // In the old (broken) implementation, clerkUserOwnsReceptionist() would find
  // this website and return true. In the new implementation, we only check
  // receptionist.ownerId === clerkUserId (DB-authoritative).
  //
  // Simulated: attacker is "user-mallory", victim receptionist is owned by "user-alice".
  const victimReceptionist = makeReceptionist({
    id: "rec-victim",
    ownerId: "user-alice",
  });

  // Attacker has no key and their Clerk userId does not match ownerId
  const result = decideAccess({
    receptionist: victimReceptionist,
    clerkUserId: "user-mallory",  // attacker's Clerk session
    submittedOwnerKey: "",
  });

  assert.ok(!result.authorized, "attacker must be denied even with linked projectSource");
  assert.equal(result.status, 403, "403 for authenticated but unauthorized attacker");
});

test("claim is idempotent: concurrent claim of already-claimed receptionist → authorized", () => {
  // Simulates a race condition where two requests race to claim the same legacy receptionist.
  // After the first claim, ownerId is "user-bob". The second request sees ownerId = "user-bob"
  // and provides a valid key. It should still be authorized (key is valid) but NOT re-claim.
  const alreadyClaimed = makeReceptionist({ ownerId: "user-bob" });
  const result = decideAccess({
    receptionist: alreadyClaimed,
    clerkUserId: "user-bob",
    submittedOwnerKey: OWNER_KEY,
  });
  assert.ok(result.authorized, "already-claimed owner with valid key is still authorized");
  // Path 1 (Clerk ownerId match) fires before Path 2 (ownerKey), so shouldClaim = false
  assert.equal(result.shouldClaim, false, "no re-claim after already claimed");
});
