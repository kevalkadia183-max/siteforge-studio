-- Migration 0008: Lead outreach Gmail reconciliation safety (Task #33 follow-up)
--
-- Forward migration AFTER already-applied 0007. Does NOT edit 0007. It:
--   1. Adds lead_acquisition_outreach_drafts.gmail_attempt_started_at, a durable
--      attempt-start timestamp that survives ambiguous outcomes and process
--      death, used to enforce the 2-minute reconciliation safety delay.
--   2. Widens the outreach events event_type CHECK to allow the new immutable
--      reconciliation event types:
--        gmail_reconciliation_pending | gmail_reconciled | gmail_retry_ready
--
-- Idempotent (IF NOT EXISTS / DROP-then-ADD guarded) so it is safe to re-run.
-- No data is rewritten; existing rows get NULL gmail_attempt_started_at, which
-- the application treats as "no in-flight attempt" (a NULL start time can never
-- satisfy the >= 2-minute delay, so such rows stay pending until a real attempt
-- records a timestamp — fail-closed).

ALTER TABLE "lead_acquisition_outreach_drafts"
	ADD COLUMN IF NOT EXISTS "gmail_attempt_started_at" timestamp with time zone;
--> statement-breakpoint

-- Widen the append-only event type CHECK to include the reconciliation events.
-- DROP-then-ADD keeps this idempotent and forward-only; the new constraint is a
-- strict superset of the old allowed set, so all existing rows remain valid.
ALTER TABLE "lead_acquisition_outreach_events"
	DROP CONSTRAINT IF EXISTS "la_outreach_events_type_check";
--> statement-breakpoint
ALTER TABLE "lead_acquisition_outreach_events"
	ADD CONSTRAINT "la_outreach_events_type_check" CHECK ("lead_acquisition_outreach_events"."event_type" IN ('created', 'edited', 'reviewed', 'discarded', 'gmail_requested', 'gmail_created', 'gmail_failed', 'gmail_reconciliation_pending', 'gmail_reconciled', 'gmail_retry_ready', 'reply_marked', 'opted_out'));
