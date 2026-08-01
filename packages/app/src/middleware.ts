/**
 * Route protection. Every page under this app is per-account (design §2:
 * multi-tenant from the first migration) — an unauthenticated request has no
 * userId to scope RLS with, so it never reaches a page component at all.
 *
 * Builds its own NextAuth instance from the Edge-safe auth.config.ts rather
 * than importing `auth` from ./auth — that file pulls in Drizzle/postgres
 * and node:crypto (via @job-digest/core's credential encryption) through its
 * DB-writing jwt callback, none of which the Edge middleware runtime can
 * bundle.
 */
import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import authConfig from './auth.config';

const { auth } = NextAuth(authConfig);

const PUBLIC_PATHS = ['/login'];

export default auth((req) => {
  const isPublic = PUBLIC_PATHS.some((p) => req.nextUrl.pathname.startsWith(p));
  const isAuthRoute = req.nextUrl.pathname.startsWith('/api/auth');
  // The mail provider calls this, not a signed-in browser — it authenticates
  // itself with its own shared secret, checked inside the route handler.
  const isInboundWebhook = req.nextUrl.pathname.startsWith('/api/inbound/');
  if (!req.auth && !isPublic && !isAuthRoute && !isInboundWebhook) {
    const url = new URL('/login', req.nextUrl.origin);
    return NextResponse.redirect(url);
  }
  if (req.auth && req.nextUrl.pathname === '/login') {
    return NextResponse.redirect(new URL('/digest', req.nextUrl.origin));
  }
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
