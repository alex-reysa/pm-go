-- Phase 7 Worker 2: extend `workflow_events` with trace correlation
-- columns + the `span_emitted` enum value. The observability package's
-- `writeSpan` inserts rows with `kind='span_emitted'` and the new
-- `trace_id`/`span_id` columns populated. Existing rows keep NULL —
-- consumers already tolerate that per the Phase 6 projection contract.
ALTER TYPE "public"."workflow_event_kind" ADD VALUE 'span_emitted';--> statement-breakpoint
ALTER TABLE "workflow_events" ADD COLUMN "trace_id" text;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD COLUMN "span_id" text;--> statement-breakpoint
CREATE INDEX "workflow_events_trace_idx" ON "workflow_events" USING btree ("trace_id");
