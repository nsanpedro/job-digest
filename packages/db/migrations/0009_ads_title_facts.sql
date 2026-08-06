-- Facts read from the title and location line (design note, "chips = hechos,
-- no veredictos", 3 Aug 2026). Nullable: existing ads predate this column and
-- are backfilled by packages/worker/scripts/backfill-title-facts.ts, not by
-- this migration — the computation needs no raw email, only title and
-- location_raw, both already stored.
--
-- No grant statement needed: `ads` gets table-level grants from migration
-- 0001's ALTER DEFAULT PRIVILEGES, unlike `mailboxes`, which grants
-- column-by-column for I13. This column is covered automatically.
ALTER TABLE "ads" ADD COLUMN "title_facts" jsonb;