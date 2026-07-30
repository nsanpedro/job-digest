/**
 * Edge-compatible slice of the auth config — no database access, no
 * node:crypto. Middleware runs on the Edge runtime by default, which cannot
 * bundle Node-only modules; the moment auth.ts's DB-writing jwt callback (and
 * @job-digest/core's credentials.ts, which imports node:crypto) got pulled
 * into the middleware bundle, the build failed outright
 * ("node:crypto ... Unhandled scheme"). This file is what middleware.ts
 * imports instead; auth.ts imports this too and adds the Node-only pieces
 * for route handlers and server components, which run on the Node runtime.
 */
import type { NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';

export default {
  providers: [
    Google({
      authorization: {
        params: {
          scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
} satisfies NextAuthConfig;
