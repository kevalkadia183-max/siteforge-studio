const PROSPECT_PREVIEW_SIGNATURE_PATH =
  /(\/api\/prospect-previews\/[^/?#]+\/)[0-9a-f]{64}(?=\/|$)/gi;
const ORDINARY_PREVIEW_TOKEN_PATH =
  /(\/api\/previews\/public\/)[^/?#]+(?=\/|$)/gi;

/**
 * Removes bearer-capability values from request URLs before they reach
 * application logs. Query strings are omitted for the same reason.
 */
export function sanitizeRequestUrlForLogs(
  url: string | undefined,
): string | undefined {
  if (!url) return url;

  return url
    .split("?")[0]
    .replace(PROSPECT_PREVIEW_SIGNATURE_PATH, "$1[redacted]")
    .replace(ORDINARY_PREVIEW_TOKEN_PATH, "$1[redacted]");
}