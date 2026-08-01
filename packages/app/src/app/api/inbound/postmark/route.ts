/**
 * Inbound webhook for forwarded mail (design §4.5). Shaped for Postmark's
 * inbound webhook specifically — chosen for this pass because it can be
 * configured to include `RawEmail` (full RFC822 text) directly in its JSON
 * payload, which is exactly what parseEml()/ingestEmail() already expect,
 * with no reformatting. Swapping providers later means adding another route
 * that extracts raw bytes from that provider's shape and calls the same
 * worker functions — the verification and ingest logic here doesn't know or
 * care which provider called it.
 *
 * No user is signed in when this fires — it's the mail provider calling us,
 * not a browser with a session. Two lookups happen outside any tenant scope
 * before we know which account this belongs to: authenticating the request
 * itself (shared-secret Basic Auth, checked against POSTMARK_INBOUND_SECRET
 * — Postmark supports Basic Auth on the webhook URL), and resolving the
 * recipient address to a mailbox row (an indexed lookup on
 * mailboxes.inbound_address, not a restricted column — no worker role
 * needed for that part). Only once a mailboxId/userId is known does
 * anything run inside a tenant-scoped transaction.
 */
import { NextResponse } from 'next/server';
import { mailboxes, runs } from '@job-digest/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ingestForwardedEmail, PARSER_VERSION } from '@job-digest/worker';
import postgres from 'postgres';

interface PostmarkInboundPayload {
  RawEmail?: string;
  To?: string;
  OriginalRecipient?: string;
}

function ownerDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = postgres(url, { max: 1 });
  return { db: drizzle(client), client };
}

function unauthorized() {
  return new NextResponse('unauthorized', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="inbound"' },
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.POSTMARK_INBOUND_SECRET;
  if (!secret) return new NextResponse('inbound webhook not configured', { status: 501 });

  const authHeader = req.headers.get('authorization') ?? '';
  const expected = 'Basic ' + Buffer.from(`inbound:${secret}`).toString('base64');
  if (authHeader !== expected) return unauthorized();

  const payload = (await req.json()) as PostmarkInboundPayload;
  const recipient = (payload.OriginalRecipient ?? payload.To ?? '').trim().toLowerCase();
  if (!recipient || !payload.RawEmail) {
    // Not our concern to explain to Postmark why — just don't crash and
    // don't retry-storm us. 200 with nothing stored is correct here: a
    // malformed payload isn't an ad we failed to read (I3's territory),
    // it's not mail at all.
    return NextResponse.json({ stored: false });
  }

  const { db, client } = ownerDb();
  try {
    const [mailbox] = await db
      .select({ id: mailboxes.id, userId: mailboxes.userId, status: mailboxes.status })
      .from(mailboxes)
      .where(eq(mailboxes.inboundAddress, recipient))
      .limit(1);
    if (!mailbox) {
      // Address doesn't exist (typo, stale filter, abuse probe) — accept
      // and drop, matching I14/§4.5: nothing about an unrecognized address
      // gets stored.
      return NextResponse.json({ stored: false });
    }

    const raw = Buffer.from(payload.RawEmail, 'utf8');
    const [run] = await db
      .insert(runs)
      .values({ userId: mailbox.userId, mailboxId: mailbox.id, parserVersion: PARSER_VERSION })
      .returning({ id: runs.id });

    const result = await ingestForwardedEmail(db, {
      userId: mailbox.userId,
      mailboxId: mailbox.id,
      runId: run!.id,
      raw,
    });

    await db
      .update(runs)
      .set({
        status: 'ok',
        emailsTotal: 1,
        emailsProcessed: result.accepted ? 1 : 0,
        finishedAt: new Date(),
      })
      .where(eq(runs.id, run!.id));

    return NextResponse.json({ stored: result.accepted });
  } finally {
    await client.end();
  }
}
