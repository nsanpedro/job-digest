-- Role discovery from a CV (docs/adr-001-role-discovery.md §3). `profiles`
-- gets a poll-friendly status (same shape as `runs.status`) rather than a
-- new table, since a completed derivation's snapshot belongs in its `data`
-- column. `directions` is new: one row per surviving direction (already past
-- I17's gates), denormalized so the UI reads it without a round trip through
-- the CV-adjacent `profiles.data` blob. `profiles` has zero rows in
-- production as of this migration — status defaulting to 'running' has no
-- pre-existing data to make retroactively wrong.
CREATE TYPE "public"."derivation_error_kind" AS ENUM('not_a_pdf', 'too_large', 'too_many_pages', 'no_text_layer', 'corrupt', 'refused', 'internal');--> statement-breakpoint
CREATE TYPE "public"."derivation_status" AS ENUM('running', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."direction_distance" AS ENUM('adjacent', 'stretch');--> statement-breakpoint
CREATE TYPE "public"."direction_state" AS ENUM('suggested', 'interested', 'dismissed', 'alert_configured');--> statement-breakpoint
CREATE TABLE "directions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"label" text NOT NULL,
	"rationale" text NOT NULL,
	"bridge" text[] NOT NULL,
	"search_terms" text[] NOT NULL,
	"distance" "direction_distance" NOT NULL,
	"seen_titles" text[] DEFAULT '{}' NOT NULL,
	"state" "direction_state" DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "status" "derivation_status" DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "error_kind" "derivation_error_kind";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "error_detail" jsonb;--> statement-breakpoint
ALTER TABLE "directions" ADD CONSTRAINT "directions_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directions_user_version_label" ON "directions" USING btree ("user_id","profile_version","label");--> statement-breakpoint
CREATE INDEX "directions_user_state" ON "directions" USING btree ("user_id","state");--> statement-breakpoint
CREATE POLICY "directions_tenant_isolation" ON "directions" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);