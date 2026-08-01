/**
 * Full auth config — Node runtime only (route handlers, server components,
 * server actions). Extends auth.config.ts with the callback that does real
 * work: linking the Google identity to our `accounts` row, and — only for
 * the separate `google-gmail` incremental-authorization flow, triggered from
 * Profile's "Connect Gmail" button — storing the encrypted OAuth refresh
 * token as a `mailboxes` row. See auth.config.ts for why this split exists,
 * both the Edge/Node file split and the two-provider identity/mailbox split.
 *
 * What connecting Gmail does NOT do yet: actually fetch or parse mail.
 * @job-digest/worker's gmail.ts does that, triggered by "Update now" — this
 * file only stores the credential that step spends.
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
      // Only runs on the initial sign-in / re-authorization, when `account`
      // (the OAuth grant) is present — not on every subsequent token use.
      if (account && profile?.email) {
        const { db, client } = ownerDb();
        try {
          // Upserts on email regardless of which provider flow triggered
          // this, so a "Connect Gmail" re-auth for an existing identity
          // sign-in resolves to the same account, never a second one.
          const [row] = await db
            .insert(accounts)
            .values({ email: profile.email })
            .onConflictDoUpdate({ target: accounts.email, set: { email: profile.email } })
            .returning({ id: accounts.id });
          token.userId = row!.id;

          // Only the explicit "Connect Gmail" flow (auth.config.ts's
          // google-gmail provider) ever stores mailbox credentials. Plain
          // identity sign-in (the `google` provider) never does — that is
          // the entire point of the split: signing in must not imply
          // granting mailbox access.
          if (account.provider === 'google-gmail' && account.refresh_token) {
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
