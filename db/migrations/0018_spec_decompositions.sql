-- Layer-A milestone decomposition spike. Persists the decomposer agent's
-- MilestoneManifest output and links plans back to the decomposition row
-- they were scoped from so plan provenance survives a re-decompose.
CREATE TABLE "spec_decompositions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"spec_document_id" uuid NOT NULL,
	"repo_snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"manifest" jsonb,
	"error_reason" text,
	"plan_first_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_decompositions_status_check" CHECK ("status" in ('pending', 'running', 'ready', 'failed')),
	CONSTRAINT "spec_decompositions_ready_has_manifest_check" CHECK (("status" = 'ready' AND "manifest" IS NOT NULL) OR ("status" <> 'ready')),
	CONSTRAINT "spec_decompositions_failed_has_reason_check" CHECK (("status" = 'failed' AND "error_reason" IS NOT NULL) OR ("status" <> 'failed'))
);
--> statement-breakpoint
ALTER TABLE "spec_decompositions" ADD CONSTRAINT "spec_decompositions_spec_document_id_spec_documents_id_fk" FOREIGN KEY ("spec_document_id") REFERENCES "public"."spec_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_decompositions" ADD CONSTRAINT "spec_decompositions_repo_snapshot_id_repo_snapshots_id_fk" FOREIGN KEY ("repo_snapshot_id") REFERENCES "public"."repo_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_decompositions_spec_document_id_idx" ON "spec_decompositions" USING btree ("spec_document_id");
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "decomposition_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "milestone_id" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "predecessor_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_decomposition_id_spec_decompositions_id_fk" FOREIGN KEY ("decomposition_id") REFERENCES "public"."spec_decompositions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_predecessor_plan_id_plans_id_fk" FOREIGN KEY ("predecessor_plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_decomposition_milestone_pair_check" CHECK (("decomposition_id" IS NULL AND "milestone_id" IS NULL) OR ("decomposition_id" IS NOT NULL AND "milestone_id" IS NOT NULL));--> statement-breakpoint
CREATE INDEX "plans_decomposition_id_idx" ON "plans" USING btree ("decomposition_id");
