/**
 * Full auth config — Node runtime only (route handlers, server components,
 * server actions). Extends auth.config.ts with the callback that does real
 * work: linking the Google identity to our `accounts` row and storing the
 * encrypted OAuth refresh token as a `mailboxes` row. See auth.config.ts for
 * why this split exists (middleware needs the Edge-safe half only).
 *
 * One sign-in does two jobs at once, by design (Nico's call, 30 Jul): it is
 * both the app account and the mailbox connection. The OAuth consent screen
 * requests gmail.readonly alongside identity scopes, so the same grant that
 * creates a session also authorizes reading the mailbox — no separate IMAP
 * flow. `access_type: offline` + `prompt: consent` (in auth.config.ts) force
 * Google to return a refresh token.
 *
 * What this does NOT do yet: actually fetch or parse mail. Connecting the
 * mailbox and reading it are different steps — this wires the first.
 *
 * Scope note (design §4.1): Google's `gmail.readonly` is a restricted scope.
 * In OAuth "Testing" publishing status (no CASA verification), only test
 * users added in the Cloud Console can sign in, and refresh tokens expire
 * after 7 days. That is fine for Nico + Ro testing this by hand; it is not
 * fine for public signup, which is why the design doc treats forwarding as
 * the public-signup path and this as the trusted-user path.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
// Subpath import, not the main barrel — see the comment in
// @job-digest/core/src/index.ts for why credentials.ts lives outside it.
import { encryptSecret } from '@job-digest/core/credentials';
import { accounts, mailboxes } from '@job-digest/db';
import NextAuth from 'next-auth';
import postgres from 'postgres';
import authConfig from './auth.config';

function credentialKey(): Buffer {
  const b64 = process.env.MAILBOX_CREDENTIAL_KEY;
  if (!b64) throw new Error('MAILBOX_CREDENTIAL_KEY is not set (32 random bytes, base64)');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('MAILBOX_CREDENTIAL_KEY must decode to exactly 32 bytes');
  return key;
}

// A dedicated connection for auth callbacks — these run outside any
// request's tenant scope (design §2: resolving "who is this" cannot itself
// be RLS-scoped), so this deliberately does not go through lib/db.ts's
// withTenant.
function ownerDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 1 });
  return { db: drizzle(client), client };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  callbacks: {
    async jwt({ token, account, profile }) {
      // Only runs on the initial sign-in, when `account` (the OAuth
      // grant) is present — not on every subsequent token refresh.
      if (account && profile?.email) {
        const { db, client } = ownerDb();
        try {
          const [row] = await db
            .insert(accounts)
            .values({ email: profile.email })
            .onConflictDoUpdate({ target: accounts.email, set: { email: profile.email } })
            .returning({ id: accounts.id });
          token.userId = row!.id;

          if (account.refresh_token) {
            const sealed = encryptSecret(account.refresh_token, credentialKey());
            await db
              .insert(mailboxes)
              .values({
                userId: row!.id,
                provider: 'google',
                authKind: 'oauth',
                emailAddress: profile.email,
                credentialsEnc: sealed,
                keyVersion: 1,
                status: 'active',
                // Google's own access-token lifetime is short; what matters
                // here is the refresh token, which Testing-status apps
                // expire in ~7 days (design §4.1) — surfaced honestly
                // rather than guessed at.
                credentialExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              })
              .onConflictDoUpdate({
                target: [mailboxes.userId, mailboxes.emailAddress],
                set: {
                  credentialsEnc: sealed,
                  status: 'active',
                  credentialExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
              });
          }
        } finally {
          await client.end();
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.userId && session.user) {
        (session.user as { id?: string }).id = token.userId as string;
      }
      return session;
    },
  },
});
