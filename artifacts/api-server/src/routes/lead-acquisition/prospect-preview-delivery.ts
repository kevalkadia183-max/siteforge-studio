/**
 * Public prospect preview delivery.
 *
 * Routes (path-segment signature — relative assets resolve correctly):
 *   GET /prospect-previews/:mappingId/:signature/         — index.html
 *   GET /prospect-previews/:mappingId/:signature/:asset   — CSS/JS/other pages
 *
 * Authentication: none (public).
 * Authorisation: HMAC-SHA256 signature verification (timingSafeEqual).
 * No raw signatures appear in logs or structured output.
 *
 * ## Frozen-site delivery
 * The generated site served here is NEVER regenerated at request time. On
 * publish, the prospect route freezes the validated GeneratedSite into a
 * client_previews row (reusing the ordinary preview store) and records its
 * id_hash on the mapping via prospect_previews.client_preview_id_hash. Public
 * delivery loads that exact frozen row and serves it verbatim. The editable
 * website source is never read or re-generated here — this guarantees the
 * published revision is delivered byte-for-byte and no editable source or
 * credentials can leak through the public path.
 *
 * On tamper/expiry/not-found: 404 no-store noindex.
 * CSP (strict prospect): img-src 'self' data: (no external media),
 * connect-src 'none'. Applied by serveStoredPreviewAsset({ strictProspect }).
 * Owner + site linkage verified server-side — mapping alone is insufficient.
 */

import { and, eq, gt } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, prospectPreviewsTable, prospectSitesTable, clientPreviewsTable } from "@workspace/db";
import { verifySignature } from "../../lib/prospect-preview-signing";
import { serveStoredPreviewAsset } from "../../lib/preview-store";

export const prospectPreviewDeliveryRouter: IRouter = Router();

function unavailable(res: Response): void {
  res.set({
    "Cache-Control": "no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  res.status(404).type("text/plain").send("This preview is unavailable.");
}

async function serveProspectPreviewAsset(req: Request, res: Response): Promise<void> {
  const mappingId = req.params["mappingId"] as string;
  const suppliedSig = req.params["signature"] as string;
  // Default to index.html when no asset param (root of the signed path)
  const assetParam = (req.params["asset"] as string | undefined) ?? "index.html";

  // Basic input sanity (mappingId must be non-empty URL-safe base64)
  if (!mappingId || !/^[A-Za-z0-9_-]{10,}$/.test(mappingId)) {
    unavailable(res);
    return;
  }
  // Signature must be a valid hex string (HMAC-SHA256 = 64 hex chars)
  if (!suppliedSig || !/^[0-9a-f]{64}$/.test(suppliedSig)) {
    unavailable(res);
    return;
  }

  // Look up the preview mapping row — must not be expired
  const [preview] = await db
    .select()
    .from(prospectPreviewsTable)
    .where(
      and(
        eq(prospectPreviewsTable.mappingId, mappingId),
        gt(prospectPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!preview) {
    unavailable(res);
    return;
  }

  // Verify HMAC signature — timingSafeEqual, storedHash comparison.
  // Never log suppliedSig or the derived signature.
  const valid = verifySignature(mappingId, suppliedSig, preview.signatureHash);
  if (!valid) {
    unavailable(res);
    return;
  }

  // Assert the prospect site still belongs to the mapping owner.
  // This prevents a mapping from being served if the lifecycle was corrupted.
  const [site] = await db
    .select({ id: prospectSitesTable.id, ownerId: prospectSitesTable.ownerId })
    .from(prospectSitesTable)
    .where(
      and(
        eq(prospectSitesTable.id, preview.prospectSiteId),
        eq(prospectSitesTable.ownerId, preview.ownerId),
      ),
    )
    .limit(1);

  if (!site) {
    unavailable(res);
    return;
  }

  // Fetch the frozen client_previews row by the stored id hash. This is the
  // exact validated GeneratedSite captured at publish time — no regeneration,
  // no editable source read. Scope by the mapping's stored hash and require it
  // to be unexpired so ordinary expiry cleanup (which cascades to the mapping)
  // and this delivery agree on liveness.
  const [frozen] = await db
    .select({ site: clientPreviewsTable.site })
    .from(clientPreviewsTable)
    .where(
      and(
        eq(clientPreviewsTable.idHash, preview.clientPreviewIdHash),
        gt(clientPreviewsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!frozen) {
    unavailable(res);
    return;
  }

  // Serve verbatim with the strict prospect CSP:
  //   img-src 'self' data:  (no external media)
  //   connect-src 'none'
  serveStoredPreviewAsset(res, frozen.site, assetParam, { strictProspect: true });
}

// Route: root of signed preview (index.html)
prospectPreviewDeliveryRouter.get(
  "/prospect-previews/:mappingId/:signature/",
  serveProspectPreviewAsset,
);

// Route: individual asset (styles.css, main.js, about.html, etc.)
prospectPreviewDeliveryRouter.get(
  "/prospect-previews/:mappingId/:signature/:asset",
  serveProspectPreviewAsset,
);
