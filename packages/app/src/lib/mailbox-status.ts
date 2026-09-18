/**
 * Gmail mailbox status for the post-login gating flow (B1) and the
 * persistent status banner (B3). One tenant-scoped read per call.
 *
 * Four states so callers match by name instead of composing booleans:
 *
 *   'missing'  — no Gmail OAuth mailbox row exists (also covers the
 *                'pending_verification' and 'disabled' enum values — the
 *                user has nothing usable and needs to (re)connect)
 *   'active'   — status='active' and (no expiry, or expiry > now)
 *   'expired'  — status='active' but credentialExpiresAt <= now (the
 *                Testing-mode 7-day cliff — the refresh_token is still
 *                in the DB but Google's next call will fail invalid_grant)
 *   'failed'   — status='auth_failed' (a scan already caught the failure
 *                and marked the row; see actions.ts's error handling)
 *
 * Reads only columns app_user is granted — I13 keeps credentialsEnc off
 * the list and this file never asks for it. Filters by
 * (provider='google', authKind='oauth') so a forwarding mailbox does not
 * satisfy the check: forwarding is a separate acquisition path (§4.5)
 * and its presence does not mean we can read the user's alerts.
 *
 * A note on that 'google' literal: mailboxes.provider is free text with
 * an old doc comment (schema.ts) that lists 'gmail' as an example, but
 * the actual writer — the JWT callback in auth.ts, line 73 — persists
 * the string 'google'. Filtering by 'gmail' matches zero rows in prod
 * and produces the redirect loop the first release of this file caused
 * (digest gate sees 'missing', bounces to /onboarding/connect-gmail,
 * that page's own status check also sees 'missing' so it never bounces
 * back — user is stuck reconnecting into a value we still refuse to
 * find). If auth.ts ever changes what it writes, this filter and the
 * schema comment both have to update together.
 */
import { and, desc, eq } from 'drizzle-orm';
import { mailboxes } from '@job-digest/db';
import { withTenant } from './session';

export type GmailStatus = 'missing' | 'active' | 'expired' | 'failed';

export interface GmailMailboxSummary {
  status: GmailStatus;
  emailAddress: string | null;
  /** When Testing-mode 7-day expiry (or a later verified-mode expiry) hits. Null before the first connect wrote it. */
  expiresAt: Date | null;
}

export async function getGmailMailboxStatus(userId: string): Promise<GmailMailboxSummary> {
  const rows = await withTenant(userId, (tx) =>
    tx
      .select({
        status: mailboxes.status,
        emailAddress: mailboxes.emailAddress,
        credentialExpiresAt: mailboxes.credentialExpiresAt,
      })
      .from(mailboxes)
      .where(
        and(
          eq(mailboxes.userId, userId),
          // See header comment: auth.ts writes 'google' here, not 'gmail'.
          eq(mailboxes.provider, 'google'),
          eq(mailboxes.authKind, 'oauth'),
        ),
      )
      .orderBy(desc(mailboxes.createdAt))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return { status: 'missing', emailAddress: null, expiresAt: null };
  if (row.status === 'auth_failed') {
    return { status: 'failed', emailAddress: row.emailAddress, expiresAt: row.credentialExpiresAt };
  }
  // 'pending_verification' and 'disabled' both leave the user without a
  // working connection; the caller reacts the same way as if no row existed.
  if (row.status !== 'active') {
    return { status: 'missing', emailAddress: row.emailAddress, expiresAt: row.credentialExpiresAt };
  }
  if (row.credentialExpiresAt && row.credentialExpiresAt.getTime() <= Date.now()) {
    return { status: 'expired', emailAddress: row.emailAddress, expiresAt: row.credentialExpiresAt };
  }
  return { status: 'active', emailAddress: row.emailAddress, expiresAt: row.credentialExpiresAt };
}
