-- ADR-003: ad enrichment — per-rule provenance and original-ad snapshot.
-- Two changes:
--   1. ads.field_provenance jsonb: per-rule source ('from_email' | 'from_ad' |
--      'unknown_after_fetch' | 'fetch_failed' | 'not_checked'). Null = not yet
--      determined (email-sourced ad, enrichment not attempted).
--   2. ad_enrichments table: one row per (user, ad) — stores the fetch result
--      and the partial facts extracted from the original job posting.

CREATE TYPE "public"."enrichment_status" AS ENUM('fetched', 'fetch_failed', 'login_required', 'tier_skip');--> statement-breakpoint

ALTER TABLE "ads" ADD COLUMN "field_provenance" jsonb;--> statement-breakpoint

CREATE TABLE "ad_enrichments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ad_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"tier" text NOT NULL,
	"status" "enrichment_status" NOT NULL,
	"extracted_facts" jsonb,
	"raw_excerpt" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "ad_enrichments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "ad_enrichments"
  ADD CONSTRAINT "ad_enrichments_user_id_accounts_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "ad_enrichments"
  ADD CONSTRAINT "ad_enrichments_ad_id_ads_id_fk"
  FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade;--> statement-breakpoint

CREATE UNIQUE INDEX "ad_enrichments_user_ad"
  ON "ad_enrichments" USING btree ("user_id", "ad_id");--> statement-breakpoint

CREATE POLICY "ad_enrichments_tenant_isolation"
  ON "ad_enrichments" AS PERMISSIVE FOR ALL
  TO "app_user", "worker"
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "ad_enrichments" TO "app_user";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "ad_enrichments" TO "worker";
