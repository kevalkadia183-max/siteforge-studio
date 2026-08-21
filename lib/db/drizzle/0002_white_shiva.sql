CREATE TABLE "retell_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'retell' NOT NULL,
	"delivery_key" text NOT NULL,
	"receptionist_id" text NOT NULL,
	"event_type" text NOT NULL,
	"call_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"signature_timestamp" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receptionist_audit_events" ALTER COLUMN "receptionist_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "retell_webhook_delivery_key_unique" ON "retell_webhook_deliveries" USING btree ("provider","delivery_key");--> statement-breakpoint
CREATE INDEX "retell_webhook_receptionist_id_idx" ON "retell_webhook_deliveries" USING btree ("receptionist_id");--> statement-breakpoint
CREATE INDEX "retell_webhook_received_at_idx" ON "retell_webhook_deliveries" USING btree ("received_at");