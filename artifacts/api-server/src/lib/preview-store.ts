/**
 * Shared preview-store logic (validation + stored-site response envelope).
 *
 * This module holds the pure, dependency-light pieces of the preview service
 * that are reused by BOTH the ordinary /previews routes and the prospect
 * preview delivery path:
 *
 *   - validateSite:            the single validation applied before a
 *                              GeneratedSite is persisted / served.
 *   - serveStoredPreviewAsset: the single source of truth for asset selection
 *                              and the response envelope (headers + CSP).
 *   - hashSecret / newSecret:  secret hashing/minting helpers.
 *   - PROSPECT_EDITOR_HASH_PREFIX: reserved editor-hash namespace so prospect
 *                              frozen rows never collide with ordinary editor
 *                              keys and are excluded from ordinary quotas.
 *
 * It intentionally imports NO Express router, logger, or DB pool — only a
 * type-only Express Response and the StoredGeneratedSite type — so it can be
 * imported in isolation (e.g. tests) without pulling in the whole server.
 * previews.ts re-exports everything here to preserve its public surface, so
 * existing importers of "../previews" are unaffected.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { StoredGeneratedSite } from "@workspace/db";

export const previewLifetimeMs = 24 * 60 * 60 * 1000;

/**
 * Editor-hash namespace prefix reserved for prospect-internal client_previews
 * rows. Prospect publishing reuses the client_previews table to freeze the
 * generated site, but those internal rows must NOT count against ordinary
 * per-editor / total capacity limits, and their editorHash values must never
 * collide with an ordinary editor key hash (which is a bare 64-char sha256 hex
 * digest). Prefixing guarantees both properties.
 */
export const PROSPECT_EDITOR_HASH_PREFIX = "prospect:";

/** True when an editorHash belongs to the prospect-internal namespace. */
export function isProspectEditorHash(value: string): boolean {
  return value.startsWith(PROSPECT_EDITOR_HASH_PREFIX);
}

const maxCombinedMediaLength = 2_800_000;
export const allowedPageNames = new Set([
  "index.html",
  "about.html",
  "services.html",
  "contact.html",
]);

export function newSecret(): string {
  return randomBytes(24).toString("base64url");
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasSafeReceptionistWidgetApis(script: string): boolean {
  const receptionistMatch = script.match(
    /\bconst receptionistId = ("[a-f0-9]{32}")\s*;/,
  );
  const apiUrlMatch = script.match(/\bconst apiUrl = ("[^"\r\n]+")\s*;/);
  if (!receptionistMatch || !apiUrlMatch) return false;

  let apiUrl: unknown;
  try {
    apiUrl = JSON.parse(apiUrlMatch[1]);
  } catch {
    return false;
  }
  if (
    typeof apiUrl !== "string" ||
    (apiUrl !== "/api" &&
      (!/^https?:\/\//.test(apiUrl) || !/\/api$/i.test(apiUrl)))
  ) {
    return false;
  }

  if (
    /\b(?:ownerKey|authorization|gmail|retell|modelPrompt)\b/i.test(script) ||
    (script.match(/\bcredentials\s*:\s*['"]omit['"]/g)?.length ?? 0) !== 3
  ) {
    return false;
  }

  const allowedFetchCalls = [
    "fetch(apiUrl + '/widget/' + receptionistId + '/config'",
    "fetch(apiUrl + '/widget/' + receptionistId + '/chat'",
    "fetch(apiUrl + '/widget/' + receptionistId + '/conversations/' + conversationId + '/messages'",
  ];
  let withoutAllowedFetches = script;
  for (const call of allowedFetchCalls) {
    if (!withoutAllowedFetches.includes(call)) return false;
    withoutAllowedFetches = withoutAllowedFetches.replace(call, "");
  }
  if (/\bfetch\s*\(/.test(withoutAllowedFetches)) return false;

  const allowedSessionHelperCalls = [
    "readChatSession('sf_chat_session_' + receptionistId)",
    "readChatSession('sf_chat_conv_' + receptionistId)",
    "readChatSession('sf_chat_escalated_' + receptionistId)",
    "writeChatSession('sf_chat_session_' + receptionistId, sessionToken)",
    "writeChatSession('sf_chat_conv_' + receptionistId, conversationId)",
    "writeChatSession('sf_chat_escalated_' + receptionistId, '1')",
  ];
  for (const call of allowedSessionHelperCalls) {
    if (!script.includes(call)) return false;
  }

  const sessionStorageCalls = script.match(/\bsessionStorage\.(?:getItem|setItem)\s*\(/g) ?? [];
  if (
    sessionStorageCalls.length !== 2 ||
    !script.includes("sessionStorage.getItem(key)") ||
    !script.includes("sessionStorage.setItem(key, value)") ||
    (script.match(/\breadChatSession\s*\(/g)?.length ?? 0) !== 4 ||
    (script.match(/\bwriteChatSession\s*\(/g)?.length ?? 0) !== 4
  ) {
    return false;
  }

  return !/\b(?:localStorage|indexedDB)\b/.test(script);
}

function getReceptionistConnectSource(script: string): string {
  if (!hasSafeReceptionistWidgetApis(script)) return "'none'";
  const apiUrlMatch = script.match(/\bconst apiUrl = ("[^"\r\n]+")\s*;/);
  if (!apiUrlMatch) return "'none'";
  try {
    const apiUrl = JSON.parse(apiUrlMatch[1]) as string;
    return apiUrl === "/api" ? "'self'" : new URL(apiUrl).origin;
  } catch {
    return "'none'";
  }
}

export function validateSite(site: StoredGeneratedSite): string | null {
  const pageEntries = Object.entries(site.pages);
  if (
    pageEntries.length === 0 ||
    pageEntries.length > allowedPageNames.size ||
    !site.pages["index.html"]
  ) {
    return "A preview must include an index page and no more than four pages.";
  }

  for (const [filename, html] of pageEntries) {
    if (!allowedPageNames.has(filename)) {
      return `Unsupported preview page: ${filename}`;
    }

    const withoutGeneratedScript = html.replace(
      /<script\s+src=["']main\.js["']\s*><\/script>/gi,
      "",
    );
    if (
      /<script\b/i.test(withoutGeneratedScript) ||
      /<(?:base|embed|iframe|object)\b/i.test(html) ||
      /\son[a-z]+\s*=/i.test(html)
    ) {
      return `Unsafe markup in preview page: ${filename}`;
    }
  }

  let combinedMediaLength = 0;
  for (const [filename, asset] of Object.entries(site.media || {})) {
    if (
      !/^[a-zA-Z0-9_-]+\.(?:jpg|png|webp|gif|avif)$/.test(filename) ||
      !/^[a-zA-Z0-9_-]+$/.test(asset.id) ||
      ![
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ].includes(asset.mimeType) ||
      !asset.dataUrl.startsWith(`data:${asset.mimeType};base64,`) ||
      !/^[A-Za-z0-9+/=\r\n]+$/.test(
        asset.dataUrl.slice(asset.dataUrl.indexOf(",") + 1),
      )
    ) {
      return `Invalid preview image: ${filename}`;
    }
    combinedMediaLength += asset.dataUrl.length;
  }
  if (combinedMediaLength > maxCombinedMediaLength) {
    return "Preview images are too large.";
  }

  const usesReceptionistApis = /\b(?:fetch|sessionStorage)\b/.test(site.js);
  if (
    /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/.test(site.js) ||
    /\b(?:localStorage|indexedDB|document\.cookie|window\.opener|window\.parent)\b/.test(
      site.js,
    ) ||
    (usesReceptionistApis && !hasSafeReceptionistWidgetApis(site.js))
  ) {
    return "Unsafe browser API in preview script.";
  }

  return null;
}

/**
 * Select and serve a single asset from a stored generated site, applying the
 * standard preview response headers and Content-Security-Policy.
 *
 * This is the single source of truth for stored-site asset selection and the
 * response envelope. It is reused for both ordinary previews and prospect
 * previews so that behaviour (asset routing, content types, cache/robots
 * headers) stays identical.
 *
 * Ordinary previews use the default CSP (img-src allows https:, connect-src
 * derived from the receptionist widget in the script). Prospect previews pass
 * `strictProspect: true`, which substitutes a hardened CSP: img-src 'self'
 * data: only (no external media) and connect-src 'none'.
 *
 * Returns true if a valid asset was served, false if a 404 was sent.
 */
export function serveStoredPreviewAsset(
  res: Response,
  site: StoredGeneratedSite,
  requestedAsset: string,
  options: { strictProspect?: boolean } = {},
): boolean {
  let content: string | Buffer | undefined;
  let contentType: string;

  if (requestedAsset === "styles.css") {
    content = site.css;
    contentType = "text/css";
  } else if (requestedAsset === "main.js") {
    content = site.js;
    contentType = "text/javascript";
  } else if (allowedPageNames.has(requestedAsset)) {
    content = site.pages[requestedAsset];
    contentType = "text/html";
  } else if (site.media?.[requestedAsset]) {
    const asset = site.media[requestedAsset];
    content = Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(",") + 1), "base64");
    contentType = asset.mimeType;
  } else {
    res.status(404).type("text/plain").send("Preview file not found.");
    return false;
  }

  if (content == null) {
    res.status(404).type("text/plain").send("Preview file not found.");
    return false;
  }

  const imgSrc = options.strictProspect ? "'self' data:" : "'self' https: data:";
  const connectSrc = options.strictProspect
    ? "'none'"
    : getReceptionistConnectSource(site.js);

  res.set({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": `sandbox allow-forms allow-popups allow-scripts allow-top-navigation-by-user-activation; default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src ${imgSrc}; font-src 'self'; connect-src ${connectSrc}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  res.status(200).type(contentType).send(content);
  return true;
}
