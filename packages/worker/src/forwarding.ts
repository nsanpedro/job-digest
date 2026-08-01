/**
 * Forwarding acquisition (design §4.5) — the public-signup path with a
 * structural privacy guarantee: we never request mailbox access at all. A
 * user forwards specific senders to a unique address we own; whatever
 * arrives converges on the exact same ingestEmail() pipeline every other
 * acquisition path uses.
 *
 * Anti-abuse (§4.5): a leaked or guessed inbound address can't be used to
 * smuggle arbitrary mail onto someone's account. Only mail whose *embedded
 * original sender* is on the allowlist is accepted — everything else is
 * dropped without being stored at all. That's a stricter, earlier check than
 * ingestEmail()'s own classify() call (that one is defensive, in case
 * something upstream let a non-allowlisted sender through); this one is the
 * primary gate for an ingress anyone on the internet can technically reach.
 *
 * Forwarding breaks SPF/DKIM alignment on the outer envelope — expected, and
 * irrelevant here, because verification never looks at the envelope. It
 * looks at the RFC5322 From: header, same as every other acquisition path
 * (classify()), with one addition: if the top-level From isn't allowlisted —
 * typical of a manual "Forward" that wraps the original as a new message —
 * this looks for an embedded message/rfc822 part and checks *that* message's
 * From instead. That covers both real ways mail clients forward mail:
 * header-preserving auto-forward filters, and wrap-as-attachment manual
 * forwards.
 */
import { randomBytes } from 'node:crypto';
import { classify, findEmbeddedMessage, parseEml, type Platform } from '@job-digest/ingest';
import { ingestEmail, type IngestResult } from './ingest-email';
import { withTenant, type Db } from './tenant';

/**
 * A high-entropy local part so a leaked address is impractical to guess
 * (16 random bytes, base32-ish — no characters that read ambiguously in an
 * email address or get mangled by a mail client). The domain is the
 * operator's own inbound-receiving domain, not something this function
 * knows about — real DNS/MX setup on a real domain is an infra step outside
 * this codebase (design §4.5), same category as the Google Cloud OAuth setup
 * connecting Gmail already needed.
 */
export function generateInboundAddress(domain: string): string {
  const token = randomBytes(16).toString('base64url').toLowerCase();
  return `u-${token}@${domain}`;
}

export interface ForwardingVerdict {
  accepted: boolean;
  platform: Platform | null;
  /** The bytes to actually ingest — the unwrapped original when nested, the message itself otherwise. */
  raw: Buffer | null;
}

/**
 * Pure decision logic — never touches the database — kept separate from the
 * orchestration below so it's directly unit-testable against real forwarded
 * mail shapes without needing Postgres.
 */
export async function verifyForwardedSender(raw: Buffer): Promise<ForwardingVerdict> {
  const outer = await parseEml(raw);
  const outerPlatform = classify(outer.fromAddr);
  if (outerPlatform !== 'not_allowlisted') {
    return { accepted: true, platform: outerPlatform, raw };
  }

  const embedded = await findEmbeddedMessage(raw);
  if (!embedded) return { accepted: false, platform: null, raw: null };

  const inner = await parseEml(embedded);
  const innerPlatform = classify(inner.fromAddr);
  if (innerPlatform === 'not_allowlisted') return { accepted: false, platform: null, raw: null };
  return { accepted: true, platform: innerPlatform, raw: embedded };
}

export interface ForwardingIngestResult {
  accepted: boolean;
  ingest?: IngestResult;
}

/**
 * Verifies and, if accepted, ingests one forwarded message under the
 * mailbox's owning tenant. Nothing is written for a rejected message — not
 * even a raw_emails row — which is the whole point: a leaked inbound address
 * cannot be used to store arbitrary mail on someone else's account.
 */
export async function ingestForwardedEmail(
  db: Db,
  params: { userId: string; mailboxId: string; runId: string; raw: Buffer },
): Promise<ForwardingIngestResult> {
  const verdict = await verifyForwardedSender(params.raw);
  if (!verdict.accepted || !verdict.raw) return { accepted: false };

  const ingest = await withTenant(db, params.userId, (tx) =>
    ingestEmail(tx, {
      userId: params.userId,
      mailboxId: params.mailboxId,
      runId: params.runId,
      raw: verdict.raw!,
    }),
  );
  return { accepted: true, ingest };
}
