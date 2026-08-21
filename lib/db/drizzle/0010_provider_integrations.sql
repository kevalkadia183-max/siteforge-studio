CREATE TABLE "lead_channel_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lead_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"evidence_ref" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_channel_consent_channel_check" CHECK ("lead_channel_consents"."channel" IN ('whatsapp')),
	CONSTRAINT "lead_channel_consent_status_check" CHECK ("lead_channel_consents"."status" IN ('granted', 'revoked', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "provider_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"capability" text NOT NULL,
	"provider_key" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"request_id" text,
	"external_ref" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_audit_capability_check" CHECK ("provider_audit_events"."capability" IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp')),
	CONSTRAINT "provider_audit_outcome_check" CHECK ("provider_audit_events"."outcome" IN ('success', 'failure', 'skipped', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "provider_quota_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"capability" text NOT NULL,
	"provider_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_ends_at" timestamp with time zone NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"limit" integer NOT NULL,
	CONSTRAINT "provider_quota_used_nonneg_check" CHECK ("provider_quota_windows"."used" >= 0),
	CONSTRAINT "provider_quota_used_lte_limit_check" CHECK ("provider_quota_windows"."used" <= "provider_quota_windows"."limit"),
	CONSTRAINT "provider_quota_capability_check" CHECK ("provider_quota_windows"."capability" IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp'))
);
--> statement-breakpoint
CREATE TABLE "provider_settings" (
	"owner_id" text NOT NULL,
	"capability" text NOT NULL,
	"provider_key" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"config" jsonb,
	"last_error" text,
	"rate_limit_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_settings_capability_check" CHECK ("provider_settings"."capability" IN ('discovery', 'website_analysis', 'image', 'email', 'whatsapp')),
	CONSTRAINT "provider_settings_status_check" CHECK ("provider_settings"."status" IN ('not_configured', 'configured', 'unavailable', 'rate_limited', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"provider_key" text NOT NULL,
	"delivery_key" text NOT NULL,
	"event_type" text,
	"external_message_id" text,
	"payload_hash" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"failure_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "provider_webhook_status_check" CHECK ("provider_webhook_deliveries"."processing_status" IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "lead_channel_consents" ADD CONSTRAINT "lead_channel_consent_owner_lead_fk" FOREIGN KEY ("owner_id","lead_id") REFERENCES "public"."lead_acquisition_leads"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_audit_events" ADD CONSTRAINT "provider_audit_events_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_quota_windows" ADD CONSTRAINT "provider_quota_windows_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_settings" ADD CONSTRAINT "provider_settings_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_webhook_deliveries" ADD CONSTRAINT "provider_webhook_deliveries_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_channel_consent_owner_lead_channel_uq" ON "lead_channel_consents" USING btree ("owner_id","lead_id","channel");--> statement-breakpoint
CREATE INDEX "lead_channel_consent_owner_idx" ON "lead_channel_consents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "lead_channel_consent_owner_lead_idx" ON "lead_channel_consents" USING btree ("owner_id","lead_id");--> statement-breakpoint
CREATE INDEX "provider_audit_owner_time_idx" ON "provider_audit_events" USING btree ("owner_id","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_audit_capability_time_idx" ON "provider_audit_events" USING btree ("capability","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_audit_owner_capability_idx" ON "provider_audit_events" USING btree ("owner_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_quota_owner_cap_prov_window_uq" ON "provider_quota_windows" USING btree ("owner_id","capability","provider_key","window_start");--> statement-breakpoint
CREATE INDEX "provider_quota_owner_capability_idx" ON "provider_quota_windows" USING btree ("owner_id","capability");--> statement-breakpoint
CREATE INDEX "provider_quota_window_ends_idx" ON "provider_quota_windows" USING btree ("window_ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_settings_pk" ON "provider_settings" USING btree ("owner_id","capability");--> statement-breakpoint
CREATE INDEX "provider_settings_owner_idx" ON "provider_settings" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhook_delivery_key_uq" ON "provider_webhook_deliveries" USING btree ("provider_key","delivery_key");--> statement-breakpoint
CREATE INDEX "provider_webhook_owner_idx" ON "provider_webhook_deliveries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_provider_received_idx" ON "provider_webhook_deliveries" USING btree ("provider_key","received_at");--> statement-breakpoint
CREATE INDEX "provider_webhook_status_idx" ON "provider_webhook_deliveries" USING btree ("processing_status");