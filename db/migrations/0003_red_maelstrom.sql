CREATE TYPE "public"."worktree_lease_status" AS ENUM('active', 'expired', 'released', 'revoked');--> statement-breakpoint
CREATE TABLE "worktree_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_root" text NOT NULL,
	"branch_name" text NOT NULL,
	"worktree_path" text NOT NULL,
	"base_sha" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "worktree_lease_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worktree_leases" ADD CONSTRAINT "worktree_leases_task_id_plan_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."plan_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worktree_leases_task_active_unique" ON "worktree_leases" USING btree ("task_id") WHERE "worktree_leases"."status" = 'active';