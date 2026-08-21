/**
 * Lead normalization and duplicate detection utilities.
 *
 * Duplicate matching stays strictly within owner scope.
 * Conservative detection: same normalized phone, email, website host,
 * OR business name + city (case-insensitive, stripped).
 *
 * Never merges records silently — callers receive duplicate lead IDs.
 * Imports are never automatically marked "verified".
 */

/** Normalize a phone number for duplicate matching: digits only, strip leading 1 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // Strip leading country code "1" for NA numbers
  const stripped =
    digits.length === 11 && digits[0] === "1" ? digits.slice(1) : digits;
  if (stripped.length < 7) return null;
  return stripped;
}

/** Normalize an email: lowercase, trimmed */
export function normalizeEmail(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

/** Extract the hostname from a URL for duplicate matching */
export function normalizeWebsiteHost(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`);
    // Remove www. prefix for normalization
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Normalize a business name: lowercase, collapse whitespace, strip punctuation */
export function normalizeBusinessName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a city name: lowercase, trimmed */
export function normalizeCity(city: string | null | undefined): string | null {
  if (!city) return null;
  return city.trim().toLowerCase();
}

export interface DuplicateCheckInput {
  phone?: string | null;
  email?: string | null;
  websiteUrl?: string | null;
  businessName: string;
  city?: string | null;
}

export interface NormalizedLeadKey {
  phone: string | null;
  email: string | null;
  websiteHost: string | null;
  businessName: string | null;
  city: string | null;
}

/** Extract normalized duplicate-check keys from a lead input */
export function extractDuplicateKeys(
  input: DuplicateCheckInput,
): NormalizedLeadKey {
  return {
    phone: normalizePhone(input.phone),
    email: normalizeEmail(input.email),
    websiteHost: normalizeWebsiteHost(input.websiteUrl),
    businessName: normalizeBusinessName(input.businessName),
    city: normalizeCity(input.city),
  };
}

export interface ExistingLeadKey {
  id: string;
  phone: string | null;
  email: string | null;
  websiteUrl: string | null;
  businessName: string;
  city: string | null;
}

/**
 * Find a duplicate among existing leads.
 * Returns the first matching lead ID, or null if no duplicate found.
 *
 * Match criteria (conservative, within owner scope only):
 * 1. Normalized phone matches a non-null existing phone
 * 2. Normalized email matches a non-null existing email
 * 3. Normalized website host matches a non-null existing website host
 * 4. Normalized businessName + city both match (name-city pair)
 */
export function findDuplicate(
  incoming: DuplicateCheckInput,
  existingLeads: ExistingLeadKey[],
): string | null {
  const inKeys = extractDuplicateKeys(incoming);

  for (const existing of existingLeads) {
    const exKeys = extractDuplicateKeys({
      phone: existing.phone,
      email: existing.email,
      websiteUrl: existing.websiteUrl,
      businessName: existing.businessName,
      city: existing.city,
    });

    // Phone match
    if (
      inKeys.phone !== null &&
      exKeys.phone !== null &&
      inKeys.phone === exKeys.phone
    ) {
      return existing.id;
    }

    // Email match
    if (
      inKeys.email !== null &&
      exKeys.email !== null &&
      inKeys.email === exKeys.email
    ) {
      return existing.id;
    }

    // Website host match
    if (
      inKeys.websiteHost !== null &&
      exKeys.websiteHost !== null &&
      inKeys.websiteHost === exKeys.websiteHost
    ) {
      return existing.id;
    }

    // Business name + city pair match
    if (
      inKeys.businessName !== null &&
      exKeys.businessName !== null &&
      inKeys.city !== null &&
      exKeys.city !== null &&
      inKeys.businessName === exKeys.businessName &&
      inKeys.city === exKeys.city
    ) {
      return existing.id;
    }
  }

  return null;
}
