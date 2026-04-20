CREATE TYPE "public"."workflow_event_kind" AS ENUM('phase_status_changed');--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"phase_id" uuid,
	"task_id" uuid,
	"kind" "workflow_event_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_events_plan_created_idx" ON "workflow_events" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_events_phase_idx" ON "workflow_events" USING btree ("phase_id");