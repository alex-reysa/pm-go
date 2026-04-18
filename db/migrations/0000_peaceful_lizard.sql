CREATE TABLE "spec_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_root" text NOT NULL,
	"repo_url" text,
	"default_branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"language_hints" text[] NOT NULL,
	"framework_hints" text[] NOT NULL,
	"build_commands" text[] NOT NULL,
	"test_commands" text[] NOT NULL,
	"ci_config_paths" text[] NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
