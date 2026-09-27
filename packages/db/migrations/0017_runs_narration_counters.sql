-- Narration counters on `runs` (feat/ingest-live-narration).
--
-- The mute loader on "Update now" made a test PM autoconclude "there won't be
-- much this week" from a quiet finish, because the button said nothing about
-- WHAT ran. This adds the honest counts the narration needs — one column per
-- number the copy quotes. Every column here traces to something the pipeline
-- already computes; nothing is fabricated to fill a sentence.
--
-- Gmail runs (mailbox_id IS NOT NULL, source_id IS NULL):
--   `ads_created`      → alerts found (new ads created from this run's emails)
--   `items_reviewed`   → left at 0 (redundant with emails_processed here)
--   `items_skipped`    → left at 0
--
-- API-source runs (source_id or apiRun counterpart; see startRefresh):
--   `ads_created`      → jobs ingested as new ads across all sources this run
--   `items_reviewed`   → total jobs pulled from all providers BEFORE the
--                        direction gate — the "187 postings reviewed" number
--   `items_skipped`    → jobs the direction gate filtered out
--
-- Following the pattern for 0012+ (memory: hand-written migrations applied
-- directly to Supabase). `runs` has table-level SELECT/INSERT/UPDATE/DELETE
-- to both app_user and worker from 0001, so new columns inherit access with
-- no additional GRANT needed. Defaults of 0 make the columns safe to read on
-- rows written before this migration ran.

ALTER TABLE "runs" ADD COLUMN "ads_created" INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "items_reviewed" INTEGER DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "items_skipped" INTEGER DEFAULT 0 NOT NULL;
