/**
 * requireAuth — Clerk session middleware.
 *
 * Derives the Clerk userId exclusively from getAuth(req) (cookie/JWT session).
 * JIT-upserts a local SiteForge user record on every authenticated request,
 * keeping updatedAt fresh and populating email from verified Clerk session
 * claims (sessionClaims.email) without making a Clerk Backend API call.
 *
 * Never logs or stores unverified request fields.
 */
import { type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, siteforgeUsersTable } from "@workspace/db";

/** Attach this to the Express request type */
declare global {
  namespace Express {
    interface Request {
      sfUserId?: string;
    }
  }
}

/**
 * Extract the email from verified Clerk session claims if safely available.
 * The `email` claim is set by Clerk on the JWT/session and is verified server-side.
 * We never read email from req.body or unverified headers.
 */
function extractVerifiedEmail(
  sessionClaims: Record<string, unknown> | null | undefined,
): string | null {
  if (!sessionClaims) return null;
  const email = sessionClaims["email"];
  if (typeof email === "string" && email.length > 0 && email.length <= 320) {
    return email;
  }
  return null;
}

/**
 * JIT-upsert the local siteforge_users row.
 * - Inserts on first encounter.
 * - Always refreshes updatedAt on subsequent requests.
 * - Populates email only when verified claims make it available; never overwrites
 *   with null (leaves nullable column alone if we have nothing better).
 */
export async function jitUpsertUser(
  clerkUserId: string,
  email: string | null,
): Promise<void> {
  if (email !== null) {
    await db
      .insert(siteforgeUsersTable)
      .values({ id: clerkUserId, email, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: siteforgeUsersTable.id,
        set: {
          email,
          updatedAt: new Date(),
        },
      });
  } else {
    // No verified email available — insert if absent, just bump updatedAt otherwise
    await db
      .insert(siteforgeUsersTable)
      .values({ id: clerkUserId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: siteforgeUsersTable.id,
        set: {
          updatedAt: new Date(),
        },
      });
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  // Extract email from verified Clerk session claims (no API call)
  const email = extractVerifiedEmail(
    auth.sessionClaims as Record<string, unknown> | null | undefined,
  );

  try {
    await jitUpsertUser(userId, email);
  } catch (err) {
    req.log.error({ error: err }, "Failed to JIT-upsert SiteForge user");
    res.status(500).json({ error: "An unexpected server error occurred." });
    return;
  }

  req.sfUserId = userId;
  next();
}
