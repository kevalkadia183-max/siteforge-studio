-- Migration 0005: Correct physical column types for lead_acquisition tables
--
-- Applied as a FORWARD migration because 0004 was already deployed to
-- development.  This file is the authoritative version for all future clean
-- installs and deployed environments.
--
-- Changes:
--   leads.review_count:   text  → integer   (nullable; guarded cast → NULL on invalid)
--   leads.score:          text  → integer   (nullable; guarded cast → NULL on invalid;
--                                            clamped 0-100)
--   leads.suppressed:     text  → boolean   (tolerates common truthy forms; defaults
--                                            anything else to FALSE; DROP DEFAULT before
--                                            conversion, SET DEFAULT false after)
--   scores.score:         text  → integer   (non-null; invalid/blank → 0 fallback;
--                                            clamped 0-100)
--   suppressions:         add unique index (lead_id, owner_id) for one-per-lead
--
-- Guarded CASE approach:
--   - Valid signed-integer text (e.g. "42", "0", "-1") is cast safely.
--   - Blank, non-numeric, or out-of-range values are converted to NULL for
--     nullable columns or to a safe bounded fallback for NOT NULL columns.
--   - review_count is further clamped to ≥ 0 (negative makes no sense).
--   - score (both tables) is clamped to [0, 100].
--   - suppressed recognises 'true', '1', 'yes', 't', 'on' (case-insensitive)
--     as TRUE; everything else becomes FALSE.
--
-- NOTE: Do NOT push or apply this to the development DB — it has already been
-- migrated by running 0005 directly.  This file exists for future clean
-- installs and production deployments.

-- ── leads.review_count: text → integer (nullable, guarded, clamped ≥ 0) ─────
ALTER TABLE "lead_acquisition_leads"
  ALTER COLUMN "review_count" TYPE integer
  USING (
    CASE
      WHEN "review_count" IS NULL THEN NULL
      WHEN trim("review_count") ~ '^-?[0-9]+$'
           AND trim("review_count")::bigint BETWEEN 0 AND 2147483647
        THEN trim("review_count")::integer
      ELSE NULL  -- blank, non-numeric, negative, or overflow → NULL
    END
  );
--> statement-breakpoint

-- ── leads.score: text → integer (nullable, guarded, clamped 0-100) ───────────
ALTER TABLE "lead_acquisition_leads"
  ALTER COLUMN "score" TYPE integer
  USING (
    CASE
      WHEN "score" IS NULL THEN NULL
      WHEN trim("score") ~ '^-?[0-9]+$'
           AND trim("score")::bigint BETWEEN 0 AND 100
        THEN trim("score")::integer
      WHEN trim("score") ~ '^-?[0-9]+$'
           AND trim("score")::bigint > 100
        THEN 100  -- clamp above-range
      ELSE NULL   -- invalid text → NULL (will be recomputed on next score call)
    END
  );
--> statement-breakpoint

-- ── leads.suppressed: text → boolean ─────────────────────────────────────────
-- Drop the text default first; it cannot be applied to a boolean column.
ALTER TABLE "lead_acquisition_leads"
  ALTER COLUMN "suppressed" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "lead_acquisition_leads"
  ALTER COLUMN "suppressed" TYPE boolean
  USING (
    lower(trim(coalesce("suppressed", 'false'))) IN ('true', '1', 'yes', 't', 'on')
  );
--> statement-breakpoint
ALTER TABLE "lead_acquisition_leads"
  ALTER COLUMN "suppressed" SET DEFAULT false;
--> statement-breakpoint

-- ── scores.score: text → integer (non-null, guarded, clamped 0-100) ──────────
-- The scores table has NOT NULL on score; use 0 as the safe fallback for any
-- invalid/blank text (the row will be recomputed by the next score call).
ALTER TABLE "lead_acquisition_scores"
  ALTER COLUMN "score" TYPE integer
  USING (
    CASE
      WHEN trim("score") ~ '^-?[0-9]+$'
           AND trim("score")::bigint BETWEEN 0 AND 100
        THEN trim("score")::integer
      WHEN trim("score") ~ '^-?[0-9]+$'
           AND trim("score")::bigint > 100
        THEN 100   -- clamp above-range
      ELSE 0       -- invalid/blank → 0 (safe bounded fallback, non-null preserved)
    END
  );
--> statement-breakpoint

-- ── suppressions: add unique index (lead_id, owner_id) ───────────────────────
-- Idempotent drop of the old non-unique index if it exists
DROP INDEX IF EXISTS "la_suppressions_lead_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "la_suppressions_lead_owner_uq"
  ON "lead_acquisition_suppressions" ("lead_id", "owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_suppressions_owner_idx"
  ON "lead_acquisition_suppressions" ("owner_id");
