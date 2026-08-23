CREATE TYPE "public"."source_provider" AS ENUM('Greenhouse', 'Lever', 'Ashby', 'Personio');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'failing', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'Greenhouse';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'Lever';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'Ashby';--> statement-breakpoint
ALTER TYPE "public"."platform" ADD VALUE 'Personio';--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "source_provider" NOT NULL,
	"external_slug" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" jsonb,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ad_sightings" ALTER COLUMN "raw_email_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_sightings" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sources_user_provider_slug" ON "sources" USING btree ("user_id","provider","external_slug");--> statement-breakpoint
CREATE INDEX "sources_user_status" ON "sources" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "ad_sightings" ADD CONSTRAINT "ad_sightings_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "sources_tenant_isolation" ON "sources" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);