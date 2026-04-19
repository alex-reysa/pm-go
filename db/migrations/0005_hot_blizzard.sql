ALTER TABLE "review_reports" ADD COLUMN "reviewed_base_sha" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "reviewed_head_sha" text NOT NULL;