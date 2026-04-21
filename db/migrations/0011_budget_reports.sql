CREATE TABLE "budget_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"total_usd" numeric(12, 4) NOT NULL,
	"total_tokens" bigint NOT NULL,
	"total_wall_clock_minutes" numeric(10, 2) NOT NULL,
	"per_task_breakdown" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_reports" ADD CONSTRAINT "budget_reports_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reports_plan_id_idx" ON "budget_reports" USING btree ("plan_id");
