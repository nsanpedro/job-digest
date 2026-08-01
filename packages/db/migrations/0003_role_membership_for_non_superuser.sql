-- SET LOCAL ROLE (used by every withTenant() in app and worker) requires the
-- connecting role to be a MEMBER of the role it's switching into — Postgres
-- lets this slide silently only for a true superuser, which is why this
-- migration was never needed against local Docker Postgres (its default
-- `postgres` user IS a superuser). Found live migrating to Supabase: their
-- `postgres` user is deliberately NOT a superuser (platform-level security
-- boundary), so app_user/worker existing wasn't enough — SET ROLE failed
-- with "permission denied to set role" until the connecting role is
-- explicitly granted membership in both.
--
-- CURRENT_USER at migration time, not a hardcoded name: this needs to work
-- whether the admin account is Docker's `postgres`, Supabase's `postgres`,
-- or whatever a future host calls it.
GRANT app_user TO CURRENT_USER;--> statement-breakpoint
GRANT worker TO CURRENT_USER;
