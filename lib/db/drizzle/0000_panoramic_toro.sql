CREATE TABLE "client_previews" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"editor_hash" text NOT NULL,
	"project_id" text NOT NULL,
	"project_updated_at" bigint NOT NULL,
	"site" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_previews_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "preview_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receptionists" (
	"id" text PRIMARY KEY NOT NULL,
	"pilot_slot" text,
	"owner_key_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"business_name" text NOT NULL,
	"business_email" text,
	"assistant_name" text DEFAULT 'Assistant' NOT NULL,
	"greeting" text,
	"knowledge" text,
	"faqs" text,
	"hours" text,
	"service_area" text,
	"escalation_contact" text,
	"prohibited_actions" text,
	"safe_auto_reply_categories" text,
	"retell_agent_id" text,
	"retell_phone_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receptionists_pilot_slot_unique" UNIQUE("pilot_slot")
);
--> statement-breakpoint
CREATE TABLE "receptionist_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"receptionist_id" text NOT NULL,
	"channel" text DEFAULT 'chat' NOT NULL,
	"external_id" text,
	"subject" text,
	"status" text DEFAULT 'open' NOT NULL,
	"session_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receptionist_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"receptionist_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"approval_state" text,
	"external_message_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receptionist_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"receptionist_id" text NOT NULL,
	"conversation_id" text,
	"message_id" text,
	"event_type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receptionist_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_previews_editor_hash_idx" ON "client_previews" USING btree ("editor_hash");--> statement-breakpoint
CREATE INDEX "client_previews_expires_at_idx" ON "client_previews" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_previews_editor_project_idx" ON "client_previews" USING btree ("editor_hash","project_id");--> statement-breakpoint
CREATE INDEX "preview_rate_limits_window_started_at_idx" ON "preview_rate_limits" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "receptionists_owner_key_hash_idx" ON "receptionists" USING btree ("owner_key_hash");--> statement-breakpoint
CREATE INDEX "receptionist_convos_receptionist_id_idx" ON "receptionist_conversations" USING btree ("receptionist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receptionist_convos_external_id_unique" ON "receptionist_conversations" USING btree ("receptionist_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "receptionist_convos_session_token_hash_idx" ON "receptionist_conversations" USING btree ("session_token_hash");--> statement-breakpoint
CREATE INDEX "receptionist_messages_receptionist_id_idx" ON "receptionist_messages" USING btree ("receptionist_id");--> statement-breakpoint
CREATE INDEX "receptionist_messages_conversation_id_idx" ON "receptionist_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receptionist_messages_external_message_id_unique" ON "receptionist_messages" USING btree ("receptionist_id","external_message_id");--> statement-breakpoint
CREATE INDEX "receptionist_messages_approval_state_idx" ON "receptionist_messages" USING btree ("approval_state");--> statement-breakpoint
CREATE INDEX "receptionist_audit_receptionist_id_idx" ON "receptionist_audit_events" USING btree ("receptionist_id");--> statement-breakpoint
CREATE INDEX "receptionist_audit_event_type_idx" ON "receptionist_audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "receptionist_audit_created_at_idx" ON "receptionist_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "receptionist_rate_limits_window_started_at_idx" ON "receptionist_rate_limits" USING btree ("window_started_at");