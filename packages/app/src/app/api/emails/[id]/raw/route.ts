/**
 * Serves a stored email's body so "Open the original email" is a real link,
 * not a stub. Scoped by RLS through withTenant — a mismatched id (wrong
 * tenant, or one that doesn't exist) returns zero rows, which this maps to
 * 404 rather than leaking a hint about other tenants' data.
 */
import { NextResponse } from 'next/server';
import { rawEmails } from '@job-digest/db';
import { eq } from 'drizzle-orm';
import { currentUserId, withTenant } from '@/lib/session';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await currentUserId();

  const rows = await withTenant(userId, (tx) =>
    tx
      .select({ bodyHtml: rawEmails.bodyHtml, bodyText: rawEmails.bodyText, subject: rawEmails.subject })
      .from(rawEmails)
      .where(eq(rawEmails.id, id))
      .limit(1),
  );
  const row = rows[0];
  if (!row) return new NextResponse('not found', { status: 404 });

  if (row.bodyHtml) {
    return new NextResponse(row.bodyHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new NextResponse(row.bodyText ?? '(no readable body)', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
