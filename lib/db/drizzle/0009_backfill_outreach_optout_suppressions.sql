-- Migration 0009: Backfill outreach opt-outs into the canonical DNC model
-- (Task #33 compliance follow-up).
--
-- Forward, data-only migration AFTER already-applied 0007/0008. Does NOT edit
-- any prior migration and changes NO schema.
--
-- Context: opt-out rows created before the round-5 fix wrote ONLY
-- lead_acquisition_outreach_optouts and never propagated to the canonical
-- Do-Not-Contact model (lead_acquisition_suppressions + leads.suppressed).
-- Every other DNC consumer (prospect generation, dashboards) reads the
-- canonical model, so those pre-existing opt-outs were silently not honored.
-- This migration backfills ALL existing opt-outs into the canonical model so
-- historical opt-outs are respected exactly like new ones.
--
-- It:
--   1. Upserts a lead_acquisition_suppressions row for every owner+lead that has
--      an outreach opt-out, using an HONEST reason that records it came from an
--      opt-out (mirrors the application's wording:
--        "Outreach opt-out: <reason>"  when the opt-out has a reason,
--        "Outreach opt-out"            otherwise).
--   2. Sets lead_acquisition_leads.suppressed = TRUE for those owner+lead pairs.
--
-- Determinism & safety:
--   * Inserted suppression ids are deterministic, collision-safe text derived
--     from a namespaced hash of (owner_id, lead_id):
--        'optout-supp-' || md5('lead_acquisition_outreach_optout:' || owner_id || ':' || lead_id)
--     so re-running the migration targets the SAME rows (no duplicate/garbage
--     ids) and cannot collide across distinct owner+lead pairs.
--   * ON CONFLICT on the unique (lead_id, owner_id) index makes the upsert
--     idempotent and preserves owner scoping — an existing manual suppression
--     is refreshed to the honest opt-out reason (opt-out is the stronger,
--     permanent signal), never duplicated.
--   * The leads UPDATE is naturally idempotent (sets TRUE) and owner-scoped via
--     the composite join on (owner_id, id).
--   * Re-applying the whole migration is a no-op beyond timestamp refresh.

-- 1. Canonical suppression rows for every existing outreach opt-out.
INSERT INTO "lead_acquisition_suppressions" ("id", "lead_id", "owner_id", "reason")
SELECT
  'optout-supp-' || md5('lead_acquisition_outreach_optout:' || o."owner_id" || ':' || o."lead_id"),
  o."lead_id",
  o."owner_id",
  CASE
    WHEN o."reason" IS NOT NULL AND btrim(o."reason") <> ''
      THEN 'Outreach opt-out: ' || o."reason"
    ELSE 'Outreach opt-out'
  END
FROM "lead_acquisition_outreach_optouts" o
ON CONFLICT ("lead_id", "owner_id") DO UPDATE
  SET "reason" = EXCLUDED."reason",
      "suppressed_at" = now();
--> statement-breakpoint

-- 2. Flip the denormalized leads.suppressed flag for those owner+lead pairs.
UPDATE "lead_acquisition_leads" l
SET "suppressed" = TRUE,
    "updated_at" = now()
FROM "lead_acquisition_outreach_optouts" o
WHERE l."owner_id" = o."owner_id"
  AND l."id" = o."lead_id"
  AND l."suppressed" = FALSE;
