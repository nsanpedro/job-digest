/**
 * Real session, backed by Auth.js (src/auth.ts). Replaces the dev-account
 * stub this file held earlier in the session — every call site already took
 * userId as a parameter or called this function, so nothing downstream
 * needed to change shape.
 *
 * Middleware already blocks unauthenticated requests from reaching any page
 * that calls this, so the missing-session throw below is a defense-in-depth
 * assertion, not an expected runtime path.
 */
import { cache } from 'react';
import { auth } from '@/auth';
import { rawPool, withTenant } from './db';

/** cache()-wrapped: the layout and its page both call this every request; one auth() call, not two. */
export const currentUser = cache(async (): Promise<{ id: string; email: string }> => {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  const email = session?.user?.email;
  if (!id || !email) {
    throw new Error('no session — middleware should have redirected to /login before this ran');
  }
  return { id, email };
});

export async function currentUserId(): Promise<string> {
  return (await currentUser()).id;
}

export { rawPool, withTenant };
