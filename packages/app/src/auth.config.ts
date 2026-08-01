/**
 * Edge-compatible slice of the auth config — no database access, no
 * node:crypto. Middleware runs on the Edge runtime by default, which cannot
 * bundle Node-only modules; the moment auth.ts's DB-writing jwt callback (and
 * @job-digest/core's credentials.ts, which imports node:crypto) got pulled
 * into the middleware bundle, the build failed outright
 * ("node:crypto ... Unhandled scheme"). This file is what middleware.ts
 * imports instead; auth.ts imports this too and adds the Node-only pieces
 * for route handlers and server components, which run on the Node runtime.
 *
 * Two Google provider entries, not one — this is the fix for a real scaling
 * wall (Nico, 31 Jul): the original single-provider config requested
 * gmail.readonly at sign-in, which put every sign-in behind Google's
 * restricted-scope gate — Testing-mode's 100-test-user allowlist, or a paid
 * CASA assessment to go public. That gate blocks *signing in at all*, not
 * just connecting a mailbox, so no amount of building a mailbox-agnostic
 * ingestion path (forwarding) would have fixed it on its own.
 *
 * `google` requests only openid/email/profile — non-sensitive scopes, which
 * Google does not gate behind verification or a test-user list even for a
 * published, non-verified app. This is what makes sign-in itself scale to
 * anyone. `google-gmail` is a separate, same-client incremental-authorization
 * request for gmail.readonly, triggered only from Profile's "Connect Gmail"
 * button — opt-in, and still subject to the test-user/CASA gate, same as
 * before, but now that gate only blocks *connecting Gmail via OAuth*, not
 * signing in. Forwarding (design §4.5) is the path for anyone who skips it.
 */
import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

// Auth.js infers AUTH_<ID>_ID/_SECRET from a provider's `id` — with a
// second id ('google-gmail') that would look for AUTH_GOOGLE_GMAIL_ID,
// which doesn't exist. Both entries are the same Google Cloud OAuth client
// (incremental authorization: one client, two authorization requests), so
// both pass clientId/clientSecret explicitly from the one pair of env vars
// instead of relying on inference for either.
const clientId = process.env.AUTH_GOOGLE_ID;
const clientSecret = process.env.AUTH_GOOGLE_SECRET;

export default {
  providers: [
    Google({
      id: 'google',
      clientId,
      clientSecret,
      authorization: { params: { scope: 'openid email profile' } },
    }),
    Google({
      id: 'google-gmail',
      clientId,
      clientSecret,
      authorization: {
        params: {
          scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
          access_type: 'offline',
          prompt: 'consent',
          include_granted_scopes: 'true',
        },
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
} satisfies NextAuthConfig;
