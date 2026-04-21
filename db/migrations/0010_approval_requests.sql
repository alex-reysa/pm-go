CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"task_id" uuid,
	"subject" text NOT NULL,
	"risk_band" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"approved_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "approval_requests_subject_check" CHECK ("subject" in ('plan', 'task')),
	CONSTRAINT "approval_requests_risk_band_check" CHECK ("risk_band" in ('high', 'catastrophic')),
	CONSTRAINT "approval_requests_status_check" CHECK ("status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "approval_requests_subject_task_link_check" CHECK (("subject" = 'task' AND "task_id" IS NOT NULL) OR ("subject" = 'plan' AND "task_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_plan_status_idx" ON "approval_requests" USING btree ("plan_id","status");
