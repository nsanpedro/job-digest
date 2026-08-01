-- mailboxes has column-level SELECT grants for app_user (I13, migration
-- 0001) rather than the table-wide grant every other table gets. Adding a
-- column to that table does not extend an existing column-level grant to
-- cover it — found live: "Update now" broke the moment last_synced_at (added
-- in 0005) was read from a query running as app_user, in RefreshButton's
-- startRefresh. Every future column added to mailboxes needs this same
-- explicit grant; nothing else on this table gets it automatically.
GRANT SELECT (last_synced_at) ON mailboxes TO app_user;
