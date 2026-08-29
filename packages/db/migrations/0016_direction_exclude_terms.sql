-- Per-direction negative keywords for the API pre-ingest gate (curated-algo
-- optimization, Phase 1). A direction like "Product Manager" matches any
-- title with those words — but "Senior Product Manager, Sales" is not what a
-- non-sales PM wants. `exclude_terms` gives the user a second-track filter:
-- if any term appears in the ad title (case-insensitive substring), the ad
-- is rejected before scoring, before ingest.
--
-- Same shape as `search_terms`: text[] with default '{}' so existing rows and
-- new derivations keep working without a backfill. Column-level grants are
-- not needed — `directions` has table-level SELECT/INSERT/UPDATE/DELETE via
-- the base grant in 0001, which automatically covers new columns.

ALTER TABLE "directions" ADD COLUMN "exclude_terms" text[] DEFAULT '{}' NOT NULL;
