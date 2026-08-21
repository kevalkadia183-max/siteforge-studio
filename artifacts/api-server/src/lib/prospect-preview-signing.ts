/**
 * Prospect preview signing helpers.
 *
 * Architecture:
 *   - Each preview has a high-entropy random `mappingId` (public, in URL).
 *   - The public URL uses path segments: /api/prospect-previews/{mappingId}/{signature}/{asset}
 *     The signature is embedded as a path segment (not a query param) so that
 *     relative asset references (styles.css, main.js) resolve correctly when
 *     the HTML page is loaded from /api/prospect-previews/{mappingId}/{signature}/
 *   - The DB stores `signatureHash = SHA256(signature)` — never the raw sig.
 *   - Delivery: extract sig from path, HMAC-verify against mappingId using
 *     timingSafeEqual, then SHA256(sig) and compare to stored signatureHash.
 *   - No raw signatures ever touch logs or structured output.
 *
 * TTL: 24 hours (consistent with ordinary client_previews).
 *
 * Rotation: generates a fresh mappingId + signature, deletes the old row,
 * inserts new row with new signatureHash.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function getSecret(): Buffer {
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 16) {
    throw new Error("SESSION_SECRET must be set and at least 16 characters.");
  }
  return Buffer.from(secret, "utf8");
}

/** Generate a cryptographically random mapping id (URL-safe base64, 32 bytes). */
export function newMappingId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Compute HMAC-SHA256(secret, mappingId) and return as hex.
 * This is the raw signature that goes in the URL path segment.
 * Never log or store this value.
 */
export function computeSignature(mappingId: string): string {
  return createHmac("sha256", getSecret()).update(mappingId).digest("hex");
}

/**
 * Hash the raw signature with SHA256 for safe DB storage.
 * `storedHash = SHA256(signature)`.
 */
export function hashSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

/**
 * Verify a client-supplied signature against a stored signatureHash.
 *
 * Steps:
 *   1. Recompute expected = HMAC-SHA256(secret, mappingId)
 *   2. Compare expected === suppliedSig with timingSafeEqual (prevents timing attacks)
 *   3. If equal, SHA256(suppliedSig) and compare to storedHash (stored in DB)
 *
 * Returns true only when both checks pass.
 * Never logs the raw signature.
 */
export function verifySignature(
  mappingId: string,
  suppliedSig: string,
  storedHash: string,
): boolean {
  try {
    const expected = computeSignature(mappingId);
    const expectedBuf = Buffer.from(expected, "hex");
    const suppliedBuf = Buffer.from(suppliedSig.length === expected.length ? suppliedSig : "", "hex");

    // Both buffers must be same length for timingSafeEqual
    if (expectedBuf.length !== suppliedBuf.length) return false;

    // Step 1: timing-safe compare of HMAC
    const hmacOk = timingSafeEqual(expectedBuf, suppliedBuf);
    if (!hmacOk) return false;

    // Step 2: verify stored hash matches hash of supplied sig
    const suppliedHash = hashSignature(suppliedSig);
    const storedHashBuf = Buffer.from(storedHash, "hex");
    const suppliedHashBuf = Buffer.from(suppliedHash, "hex");
    if (storedHashBuf.length !== suppliedHashBuf.length) return false;
    return timingSafeEqual(storedHashBuf, suppliedHashBuf);
  } catch {
    return false;
  }
}

/**
 * Build the full public preview path for a mappingId.
 * Uses path segments: /api/prospect-previews/{mappingId}/{signature}/
 * The trailing slash ensures relative asset references (styles.css, main.js)
 * resolve to /api/prospect-previews/{mappingId}/{signature}/styles.css etc.
 * Never log the returned value (contains raw signature).
 */
export function buildPreviewPath(mappingId: string): string {
  const sig = computeSignature(mappingId);
  return `/api/prospect-previews/${mappingId}/${sig}/`;
}

/** Preview lifetime: 24 hours (consistent with ordinary client_previews) */
export const PROSPECT_PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1000;

export function previewExpiresAt(): Date {
  return new Date(Date.now() + PROSPECT_PREVIEW_LIFETIME_MS);
}
