CREATE TYPE "public"."plan_status" AS ENUM('draft', 'auditing', 'approved', 'blocked', 'executing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."phase_status" AS ENUM('pending', 'planning', 'executing', 'integrating', 'auditing', 'completed', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('foundation', 'implementation', 'review', 'integration', 'release');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'ready', 'running', 'in_review', 'fixing', 'ready_to_merge', 'merged', 'blocked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_permission_mode" AS ENUM('default', 'acceptEdits', 'bypassPermissions', 'plan');--> statement-breakpoint
CREATE TYPE "public"."agent_role" AS ENUM('planner', 'partitioner', 'implementer', 'auditor', 'integrator', 'release-reviewer', 'explorer');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'timed_out', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."agent_stop_reason" AS ENUM('completed', 'budget_exceeded', 'turns_exceeded', 'timeout', 'canceled', 'error', 'scope_violation');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('plan_markdown', 'review_report', 'completion_audit_report', 'completion_evidence_bundle', 'test_report', 'event_log', 'patch_bundle', 'pr_summary');--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"spec_document_id" uuid NOT NULL,
	"repo_snapshot_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" "plan_status" NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" "phase_status" NOT NULL,
	"integration_branch" text NOT NULL,
	"base_snapshot_id" uuid NOT NULL,
	"task_ids_ordered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merge_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phase_audit_report_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"kind" "task_kind" NOT NULL,
	"status" "task_status" NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"file_scope" jsonb NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"test_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"reviewer_policy" jsonb NOT NULL,
	"requires_human_approval" boolean DEFAULT false NOT NULL,
	"max_review_fix_cycles" integer DEFAULT 2 NOT NULL,
	"branch_name" text,
	"worktree_path" text
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"from_task_id" uuid NOT NULL,
	"to_task_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	CONSTRAINT "task_dependencies_from_task_id_to_task_id_pk" PRIMARY KEY("from_task_id","to_task_id")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"workflow_run_id" text NOT NULL,
	"role" "agent_role" NOT NULL,
	"depth" integer NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"risk_level" "risk_level" NOT NULL,
	"executor" text DEFAULT 'claude' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"session_id" text,
	"parent_session_id" text,
	"permission_mode" "agent_permission_mode" NOT NULL,
	"budget_usd_cap" numeric(10, 4),
	"max_turns_cap" integer,
	"turns" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_creation_tokens" integer,
	"cache_read_tokens" integer,
	"cost_usd" numeric(10, 6),
	"stop_reason" "agent_stop_reason",
	"output_format_schema_ref" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "agent_runs_depth_range" CHECK ("agent_runs"."depth" >= 0 AND "agent_runs"."depth" <= 2)
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid,
	"plan_id" uuid,
	"kind" "artifact_kind" NOT NULL,
	"uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_task_or_plan_present" CHECK (("artifacts"."task_id" IS NOT NULL) OR ("artifacts"."plan_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_spec_document_id_spec_documents_id_fk" FOREIGN KEY ("spec_document_id") REFERENCES "public"."spec_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_repo_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("repo_snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phases" ADD CONSTRAINT "phases_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phases" ADD CONSTRAINT "phases_base_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("base_snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_from_task_id_plan_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_to_task_id_plan_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phases_plan_id_index_unique" ON "phases" USING btree ("plan_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_tasks_plan_id_slug_unique" ON "plan_tasks" USING btree ("plan_id","slug");