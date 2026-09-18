/**
 * Cookie shape shared between the server action that sets it
 * (gmail-actions.ts) and the server components that read it (the /digest
 * gate in digest/page.tsx and the GmailStatusBanner in the (app) layout).
 *
 * Lives in its own module rather than inside gmail-actions.ts because
 * Next.js's 'use server' rule (Next 15+) forbids non-async exports from a
 * server-action file — only async functions may be exported, since every
 * export becomes an addressable RPC endpoint. Splitting the constants out
 * keeps them importable from anywhere without turning them into functions
 * (and adds no runtime overhead: this file has no side effects).
 *
 * The cookie carries no identifying data — it is a per-browser flag that
 * says "skipped the Gmail prompt, do not bounce me for a week". A missing
 * or invalid cookie is the same as "not skipped". Reads happen server-side
 * only, via cookies() from next/headers.
 */

export const SKIP_GMAIL_COOKIE = 'jd_skip_gmail';
export const SKIP_GMAIL_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
