CREATE TYPE "public"."application_status" AS ENUM('applied', 'interviewing', 'offer', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."ruleset_mode" AS ENUM('steady', 'urgent');--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ad_id" uuid NOT NULL,
	"status" "application_status" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "application_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rulesets" ADD COLUMN "mode" "ruleset_mode" DEFAULT 'steady' NOT NULL;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_user_id_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_user" ON "application_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "application_events_ad_at" ON "application_events" USING btree ("ad_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "application_events_tenant_isolation" ON "application_events" AS PERMISSIVE FOR ALL TO "app_user", "worker" USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid) WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);