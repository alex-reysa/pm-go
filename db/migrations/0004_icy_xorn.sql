CREATE TYPE "public"."review_outcome" AS ENUM('pass', 'changes_requested', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."policy_actor" AS ENUM('system', 'human');--> statement-breakpoint
CREATE TYPE "public"."policy_decision_type" AS ENUM('approved', 'rejected', 'requires_human', 'budget_exceeded', 'scope_violation', 'retry_allowed', 'retry_denied');--> statement-breakpoint
CREATE TYPE "public"."policy_subject_type" AS ENUM('plan', 'task', 'merge', 'review');--> statement-breakpoint
CREATE TABLE "review_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"reviewer_run_id" uuid NOT NULL,
	"outcome" "review_outcome" NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cycle_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_reports_task_cycle_unique" UNIQUE("task_id","cycle_number")
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_type" "policy_subject_type" NOT NULL,
	"subject_id" uuid NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"decision" "policy_decision_type" NOT NULL,
	"reason" text NOT NULL,
	"actor" "policy_actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reviewer_run_id_agent_runs_id_fk" FOREIGN KEY ("reviewer_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_reports_task_created_idx" ON "review_reports" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "policy_decisions_subject_chrono_idx" ON "policy_decisions" USING btree ("subject_type","subject_id","created_at");