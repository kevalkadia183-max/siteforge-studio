CREATE TABLE "siteforge_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "siteforge_websites" (
	"owner_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"project_source" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"source_updated_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "siteforge_websites_owner_id_id_pk" PRIMARY KEY("owner_id","id")
);
--> statement-breakpoint
ALTER TABLE "receptionists" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "siteforge_websites" ADD CONSTRAINT "siteforge_websites_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "siteforge_users_created_at_idx" ON "siteforge_users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "siteforge_websites_owner_idx" ON "siteforge_websites" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "siteforge_websites_owner_status_idx" ON "siteforge_websites" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "siteforge_websites_owner_updated_idx" ON "siteforge_websites" USING btree ("owner_id","updated_at");--> statement-breakpoint
ALTER TABLE "receptionists" ADD CONSTRAINT "receptionists_owner_id_siteforge_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."siteforge_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receptionists_owner_id_idx" ON "receptionists" USING btree ("owner_id");