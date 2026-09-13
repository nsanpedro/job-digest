'use server';

/**
 * Post-login Gmail consent actions (B1/B2/B3).
 *
 * connectGmail: fire the second-consent OAuth grant. Same signIn call the
 * profile page's "Connect Gmail" button uses (profile/page.tsx:180-181) —
 * a plain form action, not the onboarding server-action variant, because
 * the caller in this flow is already onboarded (or is about to be by the
 * onboarding modal) and does not need persistOnboarding writes.
 *
 * dismissGmailPromptForAWeek: user chose "not now" on the connect page.
 * We remember that per-browser via a cookie so the /digest gate stops
 * bouncing them; the persistent status banner still says the connection
 * is not there, one click away from initiating it.
 *
 * Cookie lifetime is 7 days on purpose — the same cliff Testing-mode
 * Gmail tokens hit (auth.ts:83). One week later the user gets another
 * nudge, which happens to be right around when a connected mailbox
 * would have expired anyway: one prompt cadence, two failure modes.
 */

import { cookies } from 'next/headers';
import { signIn } from '@/auth';

export const SKIP_GMAIL_COOKIE = 'jd_skip_gmail';
export const SKIP_GMAIL_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export async function connectGmail(): Promise<void> {
  // signIn throws NEXT_REDIRECT — do not wrap it in try/catch.
  await signIn('google-gmail', { redirectTo: '/digest' });
}

export async function dismissGmailPromptForAWeek(): Promise<void> {
  const store = await cookies();
  store.set(SKIP_GMAIL_COOKIE, '1', {
    maxAge: SKIP_GMAIL_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'lax',
    // The cookie carries no identifying data — it is a per-browser "don't
    // nudge me for a week" flag — so `secure` follows the deployment: on
    // localhost this stays false to be readable over http.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}
