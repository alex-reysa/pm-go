ALTER TYPE "agent_role" ADD VALUE IF NOT EXISTS 'orchestrator';--> statement-breakpoint
CREATE TYPE "public"."agent_tool_call_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_plan_id_idx" ON "agent_runs" USING btree ("plan_id");--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"sequence" integer,
	"tool_name" text NOT NULL,
	"sanitized_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summarized_output" jsonb,
	"status" "agent_tool_call_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"error_reason" text,
	"spec_document_id" uuid,
	"repo_snapshot_id" uuid,
	"plan_id" uuid,
	"phase_id" uuid,
	"task_id" uuid
);
--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_spec_document_id_spec_documents_id_fk" FOREIGN KEY ("spec_document_id") REFERENCES "public"."spec_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_repo_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("repo_snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tool_calls_agent_run_id_idx" ON "agent_tool_calls" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_plan_id_idx" ON "agent_tool_calls" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_phase_id_idx" ON "agent_tool_calls" USING btree ("phase_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_task_id_idx" ON "agent_tool_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_spec_document_id_idx" ON "agent_tool_calls" USING btree ("spec_document_id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_repo_snapshot_id_idx" ON "agent_tool_calls" USING btree ("repo_snapshot_id");
