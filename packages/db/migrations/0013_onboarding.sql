-- Onboarding: user preferences + global preview cache.
--
-- accounts gets four new columns: onboarded_at (NULL = not yet onboarded),
-- category, city, and remote_ok. The migration also creates onboarding_cache,
-- a global table (no user_id) that holds a snapshot of jobs from curated
-- companies — readable by all tenants, writable only by worker.

ALTER TABLE "accounts" ADD COLUMN "onboarded_at" TIMESTAMP WITH TIME ZONE;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "category" TEXT;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "city" TEXT;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "remote_ok" BOOLEAN DEFAULT FALSE NOT NULL;--> statement-breakpoint
-- Column-level grants (I13 pattern): app_user can only touch what it needs.
GRANT SELECT (onboarded_at, category, city, remote_ok) ON "accounts" TO "app_user";--> statement-breakpoint
GRANT UPDATE (onboarded_at, category, city, remote_ok) ON "accounts" TO "app_user";--> statement-breakpoint
CREATE TABLE "onboarding_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"title" text NOT NULL,
	"location_raw" text,
	"external_url" text NOT NULL,
	"external_id" text NOT NULL,
	"posted_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "onboarding_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_cache_provider_slug_id" ON "onboarding_cache" USING btree ("provider","slug","external_id");--> statement-breakpoint
-- Global read: any authenticated tenant can query the preview cache.
CREATE POLICY "onboarding_cache_read" ON "onboarding_cache" AS PERMISSIVE FOR SELECT TO "app_user" USING (true);--> statement-breakpoint
GRANT SELECT ON "onboarding_cache" TO "app_user";--> statement-breakpoint
GRANT INSERT, UPDATE, DELETE ON "onboarding_cache" TO "worker";
