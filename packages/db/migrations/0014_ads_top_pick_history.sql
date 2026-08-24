-- ADR-003 §2.9 (I25): track which ads appeared in Top pick each week so we
-- can suppress re-promotion the following week. One row per (user, ad, week).
-- Pruned after 4 weeks — only the last two matter for I25, but keeping four
-- gives a small audit trail without unbounded growth.

CREATE TABLE "ads_top_pick_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	-- Which ad was promoted.
	"ad_id" uuid NOT NULL REFERENCES "ads"("id") ON DELETE CASCADE,
	-- Monday 00:00 UTC of the week this promotion happened.
	"week_start" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "ads_top_pick_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Unique: an ad appears at most once per user per week in Top pick.
CREATE UNIQUE INDEX "top_pick_history_user_ad_week"
  ON "ads_top_pick_history" ("user_id", "ad_id", "week_start");--> statement-breakpoint
-- Fast lookup for selectTiers: "which ad ids were Top pick last week for this user?"
CREATE INDEX "top_pick_history_user_week"
  ON "ads_top_pick_history" ("user_id", "week_start");--> statement-breakpoint
CREATE POLICY "ads_top_pick_history_tenant_isolation"
  ON "ads_top_pick_history" AS PERMISSIVE FOR ALL
  TO "app_user", "worker"
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "ads_top_pick_history" TO "app_user";--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "ads_top_pick_history" TO "worker";
