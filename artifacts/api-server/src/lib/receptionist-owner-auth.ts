/**
 * Shared authorization helper for receptionist owner routes.
 *
 * Security model:
 * - Auth is by ownerKeyHash stored in the DB (unforgeable secret) OR
 *   by Clerk session where receptionist.ownerId === clerkUserId (DB-authoritative).
 * - We NEVER use attacker-controlled projectSource data to derive authorization.
 *   The receptionistId in a website's projectSource is user-editable and cannot
 *   be treated as proof of ownership.
 *
 * Legacy migration (null ownerId):
 * - A receptionist created before ownerId was tracked has ownerId = null.
 * - When a request carries a valid ownerKey AND an authenticated Clerk session,
 *   we atomically claim ownerId for that user (SET WHERE ownerId IS NULL).
 *   If the claim races and ownerId is already set, we still authorize (key valid).
 *   We never overwrite a non-null ownerId.
 *
 * Public widget and webhook routes are not routed through this helper.
 */
import { and, eq, isNull } from "drizzle-orm";
import { type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { db, receptionistsTable, siteforgeUsersTable } from "@workspace/db";
import { hashSecret } from "./receptionist-auth";

type Receptionist = typeof receptionistsTable.$inferSelect;

/**
 * Atomically claim ownership of a legacy (null-ownerId) receptionist.
 * Silently no-ops if another request already claimed it concurrently.
 * Also JIT-upserts the siteforge_users row so the FK constraint is satisfied.
 */
async function claimOwnerIfLegacy(
  receptionistId: string,
  clerkUserId: string,
): Promise<void> {
  // Ensure the user row exists before writing the FK
  await db
    .insert(siteforgeUsersTable)
    .values({ id: clerkUserId })
    .onConflictDoNothing();

  // Only SET owner_id when it is still NULL — never overwrite
  await db
    .update(receptionistsTable)
    .set({ ownerId: clerkUserId, updatedAt: new Date() })
    .where(
      and(
        eq(receptionistsTable.id, receptionistId),
        isNull(receptionistsTable.ownerId),
      ),
    );
}

/**
 * Verify the caller is authorized to manage the given receptionist.
 * Returns the receptionist row on success, or sends an appropriate HTTP error.
 *
 * Authorization precedence:
 * 1. Clerk session: receptionist.ownerId === clerkUserId  → authorized
 * 2. Valid ownerKey hash match:
 *    a. If receptionist.ownerId is null AND Clerk session present → claim & authorize
 *    b. Otherwise → authorize (key holder is always valid)
 * 3. Neither → 401/403/404
 */
export async function verifyReceptionistOwner(
  req: Request,
  res: Response,
  receptionistId: string,
): Promise<Receptionist | null> {
  // Fetch the receptionist row once — single source of truth
  const [receptionist] = await db
    .select()
    .from(receptionistsTable)
    .where(eq(receptionistsTable.id, receptionistId))
    .limit(1);

  if (!receptionist) {
    res.status(404).json({ error: "Receptionist not found." });
    return null;
  }

  const auth = getAuth(req);
  const clerkUserId = auth?.userId ?? null;

  // --- Path 1: Clerk session owns this receptionist (DB-authoritative) ---
  if (clerkUserId && receptionist.ownerId === clerkUserId) {
    return receptionist;
  }

  // --- Path 2: Owner key ---
  const ownerKey = req.get("X-SiteForge-Owner-Key") ?? "";
  if (ownerKey.length >= 16) {
    const ownerKeyHash = hashSecret(ownerKey);
    if (ownerKeyHash === receptionist.ownerKeyHash) {
      // Valid key. If this is a legacy receptionist (null ownerId) and the
      // caller has an authenticated Clerk session, claim ownership atomically.
      if (receptionist.ownerId === null && clerkUserId) {
        await claimOwnerIfLegacy(receptionistId, clerkUserId);
      }
      return receptionist;
    }
  }

  // --- Neither path authorized ---
  if (clerkUserId) {
    // Authenticated Clerk user but does not own this receptionist
    res.status(403).json({ error: "Not authorized for this receptionist." });
  } else if (ownerKey.length > 0) {
    // Key was supplied but wrong — look like 404 to avoid oracle attacks
    res.status(404).json({ error: "Receptionist not found." });
  } else {
    res.status(401).json({ error: "Authentication required." });
  }
  return null;
}
