/**
 * Strip credential-like fields from website projectSource before storage or
 * response. Specifically removes ownerKey and setup/credential-like fields
 * recursively.
 *
 * Never exposes ownerKey, setup keys, or hashed secrets in any website payload.
 */

const CREDENTIAL_KEYS = new Set([
  "ownerKey",
  "ownerKeyHash",
  "setupKey",
  "secretKey",
  "apiKey",
  "apiSecret",
  "webhookSecret",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "privateKey",
]);

/**
 * Recursively strip credential-like keys from an object.
 * Works on plain objects and arrays; leaves primitives alone.
 */
export function stripCredentials<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(stripCredentials) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEYS.has(k)) continue;
      result[k] = stripCredentials(v);
    }
    return result as T;
  }
  return value;
}

/**
 * Strip credentials from a projectSource object.
 * Also removes server-owned DB fields: ownerId and revision.
 * NOTE: projectSource.createdAt and projectSource.updatedAt are legitimate
 * client-side millisecond timestamps (part of SiteProject type) — do NOT remove them.
 */
export function sanitizeProjectSource(
  projectSource: unknown,
): Record<string, unknown> {
  const stripped = stripCredentials(projectSource as Record<string, unknown>);
  // Remove server-owned top-level fields (not part of SiteProject)
  const { ownerId: _o, revision: _r, ...rest } =
    stripped as Record<string, unknown>;
  return rest;
}
