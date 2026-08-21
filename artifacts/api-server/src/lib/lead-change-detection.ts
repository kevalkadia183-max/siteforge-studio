/**
 * Lead PATCH change detection — pure, DB-free, unit-testable.
 *
 * The PATCH /leads/:leadId handler must NEVER promote a field's provenance
 * (e.g. write a `user_provided` source or list it in `changedFields`/activity)
 * unless the field's EFFECTIVE stored value actually changes. Studio's edit
 * form submits its full object just to change one field (or only the pipeline
 * status), so presence-in-payload is NOT evidence of an edit. Deriving changes
 * from a real before/after comparison closes the provenance-bypass hole and is
 * fail-closed against any client payload.
 *
 * This helper computes, for a given locked existing lead row and a validated
 * PATCH input, the set of fields whose stored value would actually change after
 * applying null-clear semantics. Only fields present in the payload
 * (`!== undefined`) are considered; a field absent from the payload is never a
 * change.
 */

/**
 * The lead fields a PATCH may modify, with how each is compared:
 *  - "string_nullable": text column; `null` clears it. Compared as the
 *    normalized effective value (null vs the stored value).
 *  - "string_required": text column that can never be null (businessName).
 *  - "number_nullable": real/int column; `null` clears it.
 *
 * pipelineStatus / websiteStatus are string columns that are never null-cleared
 * (they always carry an enum value), so they compare like string_required.
 */
const FIELD_COMPARISON = {
  businessName: "string_required",
  category: "string_nullable",
  description: "string_nullable",
  address: "string_nullable",
  city: "string_nullable",
  region: "string_nullable",
  postalCode: "string_nullable",
  country: "string_nullable",
  phone: "string_nullable",
  email: "string_nullable",
  websiteUrl: "string_nullable",
  listingUrl: "string_nullable",
  rating: "number_nullable",
  reviewCount: "number_nullable",
  services: "string_nullable",
  pipelineStatus: "string_required",
  websiteStatus: "string_required",
} as const;

export type ChangeDetectableField = keyof typeof FIELD_COMPARISON;

export const CHANGE_DETECTABLE_FIELDS = Object.keys(
  FIELD_COMPARISON,
) as ChangeDetectableField[];

type Existing = Record<string, unknown>;
type Input = Record<string, unknown>;

/**
 * Compute the effective stored value a PATCH field would end up with, applying
 * the same null-clear semantics the DB `buildUpdates` uses.
 *   - string_required: the value as-is (validation guarantees non-null).
 *   - string_nullable: `value ?? null` (undefined can't reach here; null clears).
 *   - number_nullable: `value ?? null`.
 */
function effectiveInputValue(
  kind: (typeof FIELD_COMPARISON)[ChangeDetectableField],
  value: unknown,
): unknown {
  if (kind === "string_required") return value;
  // nullable variants: null explicitly clears the column.
  return value ?? null;
}

/**
 * Normalize a value for equality comparison. Both the existing stored value and
 * the effective input value are run through this so we compare like-for-like.
 * Only null vs non-null and exact value differences count as a change; a field
 * re-submitted with its current stored value is a no-op.
 */
function normalizeForCompare(
  kind: (typeof FIELD_COMPARISON)[ChangeDetectableField],
  value: unknown,
): string | number | null {
  if (value === null || value === undefined) return null;
  if (kind === "number_nullable") {
    return typeof value === "number" ? value : Number(value);
  }
  // string comparisons: compare exact string content (no case folding — a real
  // capitalization edit IS a change the owner intends to record).
  return String(value);
}

/**
 * Returns the list of PATCH fields whose effective stored value actually
 * changes relative to `existing`. Order follows CHANGE_DETECTABLE_FIELDS for
 * determinism. Fields not present in `input` (undefined) are ignored.
 */
export function computeChangedLeadFields(
  existing: Existing,
  input: Input,
): ChangeDetectableField[] {
  const changed: ChangeDetectableField[] = [];
  for (const field of CHANGE_DETECTABLE_FIELDS) {
    if (input[field] === undefined) continue; // not present in payload → not a change
    const kind = FIELD_COMPARISON[field];
    const nextValue = effectiveInputValue(kind, input[field]);
    const before = normalizeForCompare(kind, existing[field]);
    const after = normalizeForCompare(kind, nextValue);
    if (before !== after) changed.push(field);
  }
  return changed;
}
