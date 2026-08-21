CREATE TABLE "lead_acquisition_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"business_name" text NOT NULL,
	"category" text,
	"description" text,
	"address" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text,
	"phone" text,
	"email" text,
	"website_url" text,
	"listing_url" text,
	"rating" real,
	"review_count" text,
	"services" text,
	"pipeline_status" text DEFAULT 'new' NOT NULL,
	"website_status" text DEFAULT 'unknown' NOT NULL,
	"source_provider" text,
	"source_reference" text,
	"source_state" text,
	"score" text,
	"score_band" text,
	"scored_at" timestamp with time zone,
	"suppressed" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_acquisition_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"field_name" text NOT NULL,
	"value" text,
	"provenance" text NOT NULL,
	"provider" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_acquisition_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"score" text NOT NULL,
	"band" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"weight_snapshot" jsonb NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_acquisition_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"note" text,
	"performed_by" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_acquisition_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"reason" text NOT NULL,
	"suppressed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_acquisition_leads" ADD CONSTRAINT "lead_acquisition_leads_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_sources" ADD CONSTRAINT "lead_acquisition_sources_lead_id_lead_acquisition_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead_acquisition_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_scores" ADD CONSTRAINT "lead_acquisition_scores_lead_id_lead_acquisition_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead_acquisition_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_activities" ADD CONSTRAINT "lead_acquisition_activities_lead_id_lead_acquisition_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead_acquisition_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_acquisition_suppressions" ADD CONSTRAINT "lead_acquisition_suppressions_lead_id_lead_acquisition_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead_acquisition_leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "la_leads_owner_idx" ON "lead_acquisition_leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "la_leads_owner_pipeline_idx" ON "lead_acquisition_leads" USING btree ("owner_id","pipeline_status");--> statement-breakpoint
CREATE INDEX "la_leads_owner_website_idx" ON "lead_acquisition_leads" USING btree ("owner_id","website_status");--> statement-breakpoint
CREATE INDEX "la_leads_owner_suppressed_idx" ON "lead_acquisition_leads" USING btree ("owner_id","suppressed");--> statement-breakpoint
CREATE INDEX "la_leads_owner_created_idx" ON "lead_acquisition_leads" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "la_leads_owner_name_idx" ON "lead_acquisition_leads" USING btree ("owner_id","business_name");--> statement-breakpoint
CREATE INDEX "la_sources_lead_idx" ON "lead_acquisition_sources" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "la_sources_owner_idx" ON "lead_acquisition_sources" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "la_sources_lead_field_idx" ON "lead_acquisition_sources" USING btree ("lead_id","field_name");--> statement-breakpoint
CREATE INDEX "la_scores_lead_idx" ON "lead_acquisition_scores" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "la_scores_lead_scored_idx" ON "lead_acquisition_scores" USING btree ("lead_id","scored_at");--> statement-breakpoint
CREATE INDEX "la_scores_owner_idx" ON "lead_acquisition_scores" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "la_activities_lead_idx" ON "lead_acquisition_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "la_activities_owner_idx" ON "lead_acquisition_activities" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "la_activities_lead_occurred_idx" ON "lead_acquisition_activities" USING btree ("lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "la_activities_owner_occurred_idx" ON "lead_acquisition_activities" USING btree ("owner_id","occurred_at");--> statement-breakpoint
CREATE INDEX "la_suppressions_lead_idx" ON "lead_acquisition_suppressions" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "la_suppressions_owner_idx" ON "lead_acquisition_suppressions" USING btree ("owner_id");
