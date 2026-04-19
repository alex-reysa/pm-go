CREATE TYPE "public"."worktree_lease_kind" AS ENUM('task', 'integration');--> statement-breakpoint
CREATE TYPE "public"."phase_audit_outcome" AS ENUM('pass', 'changes_requested', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."completion_audit_outcome" AS ENUM('pass', 'changes_requested', 'blocked');--> statement-breakpoint
CREATE TABLE "merge_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"integration_branch" text NOT NULL,
	"integration_lease_id" uuid,
	"merged_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_task_id" uuid,
	"integration_head_sha" text,
	"post_merge_snapshot_id" uuid,
	"integrator_run_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "phase_audit_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phase_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"merge_run_id" uuid NOT NULL,
	"auditor_run_id" uuid NOT NULL,
	"merged_head_sha" text NOT NULL,
	"outcome" "phase_audit_outcome" NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phase_audit_reports_phase_merge_unique" UNIQUE("phase_id","merge_run_id")
);
--> statement-breakpoint
CREATE TABLE "completion_audit_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"final_phase_id" uuid NOT NULL,
	"merge_run_id" uuid NOT NULL,
	"auditor_run_id" uuid NOT NULL,
	"audited_head_sha" text NOT NULL,
	"outcome" "completion_audit_outcome" NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "worktree_leases_task_active_unique";--> statement-breakpoint
ALTER TABLE "worktree_leases" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "completion_audit_report_id" uuid;--> statement-breakpoint
ALTER TABLE "worktree_leases" ADD COLUMN "phase_id" uuid;--> statement-breakpoint
ALTER TABLE "worktree_leases" ADD COLUMN "kind" "worktree_lease_kind" DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_integration_lease_id_worktree_leases_id_fk" FOREIGN KEY ("integration_lease_id") REFERENCES "public"."worktree_leases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_post_merge_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("post_merge_snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_runs" ADD CONSTRAINT "merge_runs_integrator_run_id_agent_runs_id_fk" FOREIGN KEY ("integrator_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_audit_reports" ADD CONSTRAINT "phase_audit_reports_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_audit_reports" ADD CONSTRAINT "phase_audit_reports_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_audit_reports" ADD CONSTRAINT "phase_audit_reports_merge_run_id_merge_runs_id_fk" FOREIGN KEY ("merge_run_id") REFERENCES "public"."merge_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_audit_reports" ADD CONSTRAINT "phase_audit_reports_auditor_run_id_agent_runs_id_fk" FOREIGN KEY ("auditor_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_audit_reports" ADD CONSTRAINT "completion_audit_reports_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_audit_reports" ADD CONSTRAINT "completion_audit_reports_final_phase_id_phases_id_fk" FOREIGN KEY ("final_phase_id") REFERENCES "public"."phases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_audit_reports" ADD CONSTRAINT "completion_audit_reports_merge_run_id_merge_runs_id_fk" FOREIGN KEY ("merge_run_id") REFERENCES "public"."merge_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_audit_reports" ADD CONSTRAINT "completion_audit_reports_auditor_run_id_agent_runs_id_fk" FOREIGN KEY ("auditor_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merge_runs_phase_in_flight_unique" ON "merge_runs" USING btree ("phase_id") WHERE "merge_runs"."completed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "merge_runs_phase_started_idx" ON "merge_runs" USING btree ("phase_id","started_at");--> statement-breakpoint
CREATE INDEX "phase_audit_reports_phase_created_idx" ON "phase_audit_reports" USING btree ("phase_id","created_at");--> statement-breakpoint
CREATE INDEX "completion_audit_reports_plan_created_idx" ON "completion_audit_reports" USING btree ("plan_id","created_at");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_completion_audit_report_id_completion_audit_reports_id_fk" FOREIGN KEY ("completion_audit_report_id") REFERENCES "public"."completion_audit_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worktree_leases" ADD CONSTRAINT "worktree_leases_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worktree_leases_phase_active_unique" ON "worktree_leases" USING btree ("phase_id") WHERE "worktree_leases"."status" = 'active' AND "worktree_leases"."kind" = 'integration';--> statement-breakpoint
CREATE UNIQUE INDEX "worktree_leases_task_active_unique" ON "worktree_leases" USING btree ("task_id") WHERE "worktree_leases"."status" = 'active' AND "worktree_leases"."kind" = 'task';--> statement-breakpoint
ALTER TABLE "worktree_leases" ADD CONSTRAINT "worktree_leases_kind_correlation" CHECK ((
        ("worktree_leases"."kind" = 'task' AND "worktree_leases"."task_id" IS NOT NULL AND "worktree_leases"."phase_id" IS NULL)
        OR
        ("worktree_leases"."kind" = 'integration' AND "worktree_leases"."task_id" IS NULL AND "worktree_leases"."phase_id" IS NOT NULL)
      ));