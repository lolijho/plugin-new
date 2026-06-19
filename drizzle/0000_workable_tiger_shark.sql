CREATE TYPE "public"."memory_kind" AS ENUM('lesson', 'error', 'pattern', 'preference', 'snippet');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'architect', 'coder', 'reviewer', 'system');--> statement-breakpoint
CREATE TYPE "public"."plugin_status" AS ENUM('draft', 'architecting', 'awaiting_approval', 'generating', 'reviewing', 'ready', 'needs_fixes', 'failed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "generations" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"phase" text DEFAULT 'architecting' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plugin_id" text,
	"kind" "memory_kind" DEFAULT 'lesson' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"importance" integer DEFAULT 1 NOT NULL,
	"embedding" vector(1536),
	"source_generation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"generation_id" text,
	"role" "message_role" NOT NULL,
	"phase" text,
	"content" text NOT NULL,
	"model" text,
	"prompt_tokens" integer DEFAULT 0,
	"completion_tokens" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_files" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"generation_id" text,
	"path" text NOT NULL,
	"language" text DEFAULT 'php' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"worst_severity" "severity",
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "plugin_status" DEFAULT 'draft' NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"manifest" jsonb,
	"model_override" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"generation_id" text,
	"file_id" text,
	"file_path" text DEFAULT '' NOT NULL,
	"severity" "severity" DEFAULT 'medium' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"line" integer,
	"message" text NOT NULL,
	"suggestion" text,
	"resolved" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'reviewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_files" ADD CONSTRAINT "plugin_files_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_file_id_plugin_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."plugin_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generations_plugin_idx" ON "generations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "memory_user_idx" ON "memory_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_kind_idx" ON "memory_entries" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "memory_embedding_idx" ON "memory_entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "messages_plugin_idx" ON "messages" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_files_plugin_idx" ON "plugin_files" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugins_user_idx" ON "plugins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "review_findings_plugin_idx" ON "review_findings" USING btree ("plugin_id");