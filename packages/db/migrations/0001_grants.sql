-- Grants for the two app roles (design §2). drizzle-kit manages tables and
-- policies; privileges are hand-written here. RLS restricts *rows*; these
-- grants restrict *columns and tables*. Neither role owns anything, so RLS
-- always applies to them.

GRANT USAGE ON SCHEMA public TO app_user;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO worker;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO worker;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, worker;--> statement-breakpoint

-- Reference data is written by migrations/ops only, read by everyone.
-- The worker may register newly discovered layouts (§5.3).
REVOKE INSERT, UPDATE, DELETE ON platform_capabilities, tvoed_rates FROM app_user, worker;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON layouts FROM app_user;--> statement-breakpoint

-- I13 at the database level: the web role can create, replace and delete
-- credentials, but can never read the ciphertext back — SELECT on mailboxes
-- is granted column by column, with credentials_enc deliberately absent.
-- A compromised web process cannot exfiltrate what it cannot select.
REVOKE SELECT ON mailboxes FROM app_user;--> statement-breakpoint
GRANT SELECT (
  id, user_id, provider, auth_kind, email_address, inbound_address,
  key_version, last_uid_seen, uid_validity, status, credential_expires_at,
  created_at
) ON mailboxes TO app_user;
