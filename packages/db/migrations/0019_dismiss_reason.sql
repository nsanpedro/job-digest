-- Dismiss reasons as explicit feedback (ADR-003 §8.x).
--
-- Two changes:
--   1. ad_user_state.dismiss_reason: why the user dismissed an ad, from a
--      closed set. Nullable — the reason is an optional follow-up to a
--      one-click dismiss, and every row written before this migration has
--      none. No column grant needed: ad_user_state has table-level
--      SELECT/INSERT/UPDATE/DELETE for app_user and worker from 0001, which
--      covers new columns (same note as 0016).
--   2. feedback_effects: one row per effect a reason had — a muted company,
--      or an exclude term the user confirmed for a direction. Timestamped so
--      the ranking eval can replay a week with only the effects that existed
--      before it started; deleted to undo (Unmute / Remove).
--
-- Idempotent throughout (guarded enum creation, IF NOT EXISTS, DROP POLICY
-- IF EXISTS before CREATE): these hand-written migrations are applied
-- directly, and a re-run must be harmless. Not in meta/_journal.json — same
-- as 0012+.

DO $$ BEGIN
  CREATE TYPE "public"."dismiss_reason" AS ENUM('wrong_role', 'wrong_level', 'location', 'company', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."feedback_effect_kind" AS ENUM('mute_company', 'exclude_term');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "ad_user_state" ADD COLUMN IF NOT EXISTS "dismiss_reason" "dismiss_reason";--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "feedback_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "public"."accounts"("id") ON DELETE cascade,
	"kind" "feedback_effect_kind" NOT NULL,
	-- The dismissal that produced the effect; the effect outlives the ad.
	"ad_id" uuid REFERENCES "public"."ads"("id") ON DELETE set null,
	-- Set for exclude_term only (the term itself lives in directions.exclude_terms).
	"direction_id" uuid REFERENCES "public"."directions"("id") ON DELETE cascade,
	-- Company as the ad spelled it, or the exclude term as saved.
	"value" text NOT NULL,
	-- Normalised company key for a mute; the lowercased term for an exclude.
	"value_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_effects_direction_kind"
	  CHECK (("kind" = 'exclude_term') = ("direction_id" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "feedback_effects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_effects_user"
  ON "feedback_effects" USING btree ("user_id");--> statement-breakpoint
-- A company is muted at most once per user; a term excluded at most once per direction.
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_effects_mute_unique"
  ON "feedback_effects" USING btree ("user_id", "value_key")
  WHERE "kind" = 'mute_company';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_effects_exclude_unique"
  ON "feedback_effects" USING btree ("direction_id", "value_key")
  WHERE "kind" = 'exclude_term';--> statement-breakpoint

DROP POLICY IF EXISTS "feedback_effects_tenant_isolation" ON "feedback_effects";--> statement-breakpoint
CREATE POLICY "feedback_effects_tenant_isolation"
  ON "feedback_effects" AS PERMISSIVE FOR ALL
  TO "app_user", "worker"
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint

-- The web role creates and removes effects (dismiss follow-up, Unmute,
-- Remove); nothing ever edits one in place. The worker only reads them
-- (ranking eval).
GRANT SELECT, INSERT, DELETE ON "feedback_effects" TO "app_user";--> statement-breakpoint
GRANT SELECT ON "feedback_effects" TO "worker";
