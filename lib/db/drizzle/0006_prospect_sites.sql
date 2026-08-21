-- Migration 0006: Prospect site lifecycle support
--
-- Changes:
--   1. siteforge_websites: add site_type column (text NOT NULL DEFAULT 'customer',
--      CHECK customer|prospect) + composite index on (owner_id, site_type).
--   2. lead_acquisition_leads: add UNIQUE index (owner_id, id) to support
--      efficient prospect lifecycle locking and composite FK references.
--   3. lead_acquisition_prospect_sites: new lifecycle table.
--      - generation_count: integer (not text); CHECK >= 0
--      - state: CHECK IN (active_draft | archived | converted)
--      - UNIQUE(owner_id, id): so child tables can composite-FK to it
--      - UNIQUE(owner_id, website_id): at most one active prospect per website (NULLable)
--      - Composite FK (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
--      - Composite FK (owner_id, website_id) -> siteforge_websites(owner_id, id)
--   4. lead_acquisition_prospect_generations: new append-only generation history.
--      - website_revision: integer (not text); CHECK >= 0
--      - status: CHECK IN (active | superseded | archived | converted)
--      - UNIQUE(owner_id, website_id): each website belongs to exactly one generation
--      - Composite FK (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
--      - Composite FK (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
--      - Composite FK (owner_id, website_id) -> siteforge_websites(owner_id, id)
--   5. lead_acquisition_prospect_previews: new signed preview mapping table.
--      - website_revision: integer (not text)
--      - Composite FK (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
--      - Composite FK (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
--      - Composite FK (owner_id, website_id) -> siteforge_websites(owner_id, id)
--      - client_preview FK ON DELETE CASCADE retained
--
-- Safe to run on already-migrated databases (idempotent checks where needed).

-- ── 1. siteforge_websites.site_type ──────────────────────────────────────────
ALTER TABLE "siteforge_websites"
  ADD COLUMN IF NOT EXISTS "site_type" text NOT NULL DEFAULT 'customer';
--> statement-breakpoint

ALTER TABLE "siteforge_websites"
  DROP CONSTRAINT IF EXISTS "siteforge_websites_site_type_check";
--> statement-breakpoint

ALTER TABLE "siteforge_websites"
  ADD CONSTRAINT "siteforge_websites_site_type_check"
  CHECK ("site_type" IN ('customer', 'prospect'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "siteforge_websites_owner_type_idx"
  ON "siteforge_websites" ("owner_id", "site_type");
--> statement-breakpoint

-- ── 2. lead_acquisition_leads composite UNIQUE index ─────────────────────────
-- A UNIQUE index (not just INDEX) on (owner_id, id) is required so that
-- composite FK references from child tables (owner_id → leads.owner_id,
-- lead_id → leads.id) are possible in PostgreSQL.
CREATE UNIQUE INDEX IF NOT EXISTS "la_leads_owner_id_uq"
  ON "lead_acquisition_leads" ("owner_id", "id");
--> statement-breakpoint

-- ── 3. lead_acquisition_prospect_sites ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lead_acquisition_prospect_sites" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "siteforge_users"("id"),
  "lead_id" text NOT NULL REFERENCES "lead_acquisition_leads"("id"),
  "state" text NOT NULL DEFAULT 'active_draft'
    CONSTRAINT "la_prospect_sites_state_check"
    CHECK ("state" IN ('active_draft', 'archived', 'converted')),
  "website_id" text,
  "verified_fields_snapshot" jsonb,
  "generation_count" integer NOT NULL DEFAULT 0
    CONSTRAINT "la_prospect_sites_generation_count_check"
    CHECK ("generation_count" >= 0),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  "converted_at" timestamp with time zone
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "la_prospect_sites_lead_owner_uq"
  ON "lead_acquisition_prospect_sites" ("lead_id", "owner_id");
--> statement-breakpoint

-- UNIQUE(owner_id, id): needed so child tables can composite-FK to it
CREATE UNIQUE INDEX IF NOT EXISTS "la_prospect_sites_owner_id_uq"
  ON "lead_acquisition_prospect_sites" ("owner_id", "id");
--> statement-breakpoint

-- UNIQUE(owner_id, website_id): at most one active prospect site per website per owner.
-- NULLs are not distinct in PostgreSQL unique indexes, so multiple NULL website_ids
-- for the same owner are allowed (desired when state=archived/converted).
CREATE UNIQUE INDEX IF NOT EXISTS "la_prospect_sites_owner_website_uq"
  ON "lead_acquisition_prospect_sites" ("owner_id", "website_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_sites_owner_idx"
  ON "lead_acquisition_prospect_sites" ("owner_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_sites_owner_state_idx"
  ON "lead_acquisition_prospect_sites" ("owner_id", "state");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_sites_website_idx"
  ON "lead_acquisition_prospect_sites" ("website_id");
--> statement-breakpoint

-- Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_sites"
  DROP CONSTRAINT IF EXISTS "la_prospect_sites_owner_lead_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_sites"
  ADD CONSTRAINT "la_prospect_sites_owner_lead_fk"
  FOREIGN KEY ("owner_id", "lead_id")
  REFERENCES "lead_acquisition_leads" ("owner_id", "id");
--> statement-breakpoint

-- Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
-- PostgreSQL enforces this only when website_id IS NOT NULL (standard NULL FK behaviour)
ALTER TABLE "lead_acquisition_prospect_sites"
  DROP CONSTRAINT IF EXISTS "la_prospect_sites_owner_website_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_sites"
  ADD CONSTRAINT "la_prospect_sites_owner_website_fk"
  FOREIGN KEY ("owner_id", "website_id")
  REFERENCES "siteforge_websites" ("owner_id", "id");
--> statement-breakpoint

-- ── 4. lead_acquisition_prospect_generations ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "lead_acquisition_prospect_generations" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL REFERENCES "siteforge_users"("id"),
  "lead_id" text NOT NULL REFERENCES "lead_acquisition_leads"("id"),
  "prospect_site_id" text NOT NULL REFERENCES "lead_acquisition_prospect_sites"("id"),
  "website_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active'
    CONSTRAINT "la_prospect_gens_status_check"
    CHECK ("status" IN ('active', 'superseded', 'archived', 'converted')),
  "template_id" text,
  "verified_fields_snapshot" jsonb,
  "website_revision" integer NOT NULL DEFAULT 0
    CONSTRAINT "la_prospect_gens_website_revision_check"
    CHECK ("website_revision" >= 0),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "superseded_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "converted_at" timestamp with time zone
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_gens_owner_idx"
  ON "lead_acquisition_prospect_generations" ("owner_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_gens_lead_idx"
  ON "lead_acquisition_prospect_generations" ("lead_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_gens_site_idx"
  ON "lead_acquisition_prospect_generations" ("prospect_site_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_gens_website_idx"
  ON "lead_acquisition_prospect_generations" ("website_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_gens_status_idx"
  ON "lead_acquisition_prospect_generations" ("status");
--> statement-breakpoint

-- UNIQUE(owner_id, website_id): each website is created fresh per generation (1:1)
CREATE UNIQUE INDEX IF NOT EXISTS "la_prospect_gens_owner_website_uq"
  ON "lead_acquisition_prospect_generations" ("owner_id", "website_id");
--> statement-breakpoint

-- Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_generations"
  DROP CONSTRAINT IF EXISTS "la_prospect_gens_owner_lead_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_generations"
  ADD CONSTRAINT "la_prospect_gens_owner_lead_fk"
  FOREIGN KEY ("owner_id", "lead_id")
  REFERENCES "lead_acquisition_leads" ("owner_id", "id");
--> statement-breakpoint

-- Composite FK: (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_generations"
  DROP CONSTRAINT IF EXISTS "la_prospect_gens_owner_site_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_generations"
  ADD CONSTRAINT "la_prospect_gens_owner_site_fk"
  FOREIGN KEY ("owner_id", "prospect_site_id")
  REFERENCES "lead_acquisition_prospect_sites" ("owner_id", "id");
--> statement-breakpoint

-- Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_generations"
  DROP CONSTRAINT IF EXISTS "la_prospect_gens_owner_website_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_generations"
  ADD CONSTRAINT "la_prospect_gens_owner_website_fk"
  FOREIGN KEY ("owner_id", "website_id")
  REFERENCES "siteforge_websites" ("owner_id", "id");
--> statement-breakpoint

-- ── 5. lead_acquisition_prospect_previews ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lead_acquisition_prospect_previews" (
  "mapping_id" text PRIMARY KEY NOT NULL,
  "signature_hash" text NOT NULL,
  "owner_id" text NOT NULL REFERENCES "siteforge_users"("id"),
  "lead_id" text NOT NULL REFERENCES "lead_acquisition_leads"("id"),
  "prospect_site_id" text NOT NULL REFERENCES "lead_acquisition_prospect_sites"("id") ON DELETE CASCADE,
  -- FK to the frozen client_previews row holding the exact published generated
  -- site. ON DELETE CASCADE so deleting the frozen preview also drops the
  -- mapping. NOT NULL: every prospect mapping references a frozen site.
  "client_preview_id_hash" text NOT NULL REFERENCES "client_previews"("id_hash") ON DELETE CASCADE,
  "website_id" text NOT NULL,
  "website_revision" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "la_prospect_previews_lead_owner_uq"
  ON "lead_acquisition_prospect_previews" ("lead_id", "owner_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_previews_owner_idx"
  ON "lead_acquisition_prospect_previews" ("owner_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_previews_expires_idx"
  ON "lead_acquisition_prospect_previews" ("expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_previews_site_idx"
  ON "lead_acquisition_prospect_previews" ("prospect_site_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "la_prospect_previews_client_preview_idx"
  ON "lead_acquisition_prospect_previews" ("client_preview_id_hash");
--> statement-breakpoint

-- Composite FK: (owner_id, lead_id) -> lead_acquisition_leads(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_previews"
  DROP CONSTRAINT IF EXISTS "la_prospect_previews_owner_lead_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_previews"
  ADD CONSTRAINT "la_prospect_previews_owner_lead_fk"
  FOREIGN KEY ("owner_id", "lead_id")
  REFERENCES "lead_acquisition_leads" ("owner_id", "id");
--> statement-breakpoint

-- Composite FK: (owner_id, prospect_site_id) -> lead_acquisition_prospect_sites(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_previews"
  DROP CONSTRAINT IF EXISTS "la_prospect_previews_owner_site_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_previews"
  ADD CONSTRAINT "la_prospect_previews_owner_site_fk"
  FOREIGN KEY ("owner_id", "prospect_site_id")
  REFERENCES "lead_acquisition_prospect_sites" ("owner_id", "id");
--> statement-breakpoint

-- Composite FK: (owner_id, website_id) -> siteforge_websites(owner_id, id)
ALTER TABLE "lead_acquisition_prospect_previews"
  DROP CONSTRAINT IF EXISTS "la_prospect_previews_owner_website_fk";
--> statement-breakpoint

ALTER TABLE "lead_acquisition_prospect_previews"
  ADD CONSTRAINT "la_prospect_previews_owner_website_fk"
  FOREIGN KEY ("owner_id", "website_id")
  REFERENCES "siteforge_websites" ("owner_id", "id");
