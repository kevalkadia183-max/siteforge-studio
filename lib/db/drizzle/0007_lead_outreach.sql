-- Migration 0007: Lead outreach model (Task #33)
--
-- Adds three new owner-scoped, auditable outreach tables. This migration only
-- ADDS the outreach tables/constraints/indexes; it does not touch any existing
-- table's structure. Idempotent (IF NOT EXISTS / guarded) so it is safe to run
-- on databases already carrying the schema.
--
--   lead_acquisition_outreach_drafts  — mutable draft state (composite FK to leads)
--   lead_acquisition_outreach_events  — append-only history (composite FK to drafts)
--   lead_acquisition_outreach_optouts — durable outreach opt-out (composite FK to leads)

CREATE TABLE IF NOT EXISTS "lead_acquisition_outreach_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"gmail_state" text DEFAULT 'none' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"fact_snapshot" jsonb,
	"gmail_operation_key" text,
	"gmail_draft_id" text,
	"gmail_message_id" text,
	"gmail_reconciliation_token" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"gmail_draft_created_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	CONSTRAINT "la_outreach_drafts_channel_check" CHECK ("lead_acquisition_outreach_drafts"."channel" IN ('email', 'whatsapp')),
	CONSTRAINT "la_outreach_drafts_status_check" CHECK ("lead_acquisition_outreach_drafts"."status" IN ('draft', 'reviewed', 'gmail_draft_created', 'discarded', 'replied')),
	CONSTRAINT "la_outreach_drafts_gmail_state_check" CHECK ("lead_acquisition_outreach_drafts"."gmail_state" IN ('none', 'requesting', 'created', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_acquisition_outreach_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"draft_id" text NOT NULL,
	"event_type" text NOT NULL,
	"detail" jsonb,
	"performed_by" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "la_outreach_events_type_check" CHECK ("lead_acquisition_outreach_events"."event_type" IN ('created', 'edited', 'reviewed', 'discarded', 'gmail_requested', 'gmail_created', 'gmail_failed', 'reply_marked', 'opted_out'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_acquisition_outreach_optouts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"reason" text,
	"channel" text,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "la_outreach_optouts_channel_check" CHECK ("lead_acquisition_outreach_optouts"."channel" IS NULL OR "lead_acquisition_outreach_optouts"."channel" IN ('email', 'whatsapp'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_owner_idx" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_lead_idx" ON "lead_acquisition_outreach_drafts" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_owner_lead_idx" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_owner_status_idx" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_owner_channel_idx" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id","channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_drafts_owner_created_idx" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "la_outreach_drafts_owner_id_uq" ON "lead_acquisition_outreach_drafts" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_events_draft_idx" ON "lead_acquisition_outreach_events" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_events_owner_idx" ON "lead_acquisition_outreach_events" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_events_lead_idx" ON "lead_acquisition_outreach_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_events_draft_occurred_idx" ON "lead_acquisition_outreach_events" USING btree ("draft_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "la_outreach_optouts_owner_lead_uq" ON "lead_acquisition_outreach_optouts" USING btree ("owner_id","lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_outreach_optouts_owner_idx" ON "lead_acquisition_outreach_optouts" USING btree ("owner_id");--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_drafts" ADD CONSTRAINT "lead_acquisition_outreach_drafts_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_drafts" ADD CONSTRAINT "lead_acquisition_outreach_drafts_lead_id_lead_acquisition_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead_acquisition_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_drafts" ADD CONSTRAINT "la_outreach_drafts_owner_lead_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."lead_acquisition_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_events" ADD CONSTRAINT "la_outreach_events_owner_draft_fk" FOREIGN KEY ("owner_id","draft_id") REFERENCES "public"."lead_acquisition_outreach_drafts"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_optouts" ADD CONSTRAINT "la_outreach_optouts_owner_lead_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."lead_acquisition_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;
