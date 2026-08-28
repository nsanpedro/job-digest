/**
 * Real mailbox acquisition via the Gmail API (design §6.1's fetch stage,
 * finally wired to a real inbox instead of local fixtures). This is the
 * piece that was missing after login: OAuth already stores an encrypted
 * refresh token per §4.2; this module spends it.
 *
 * I14 still holds here, adapted to Gmail's model instead of IMAP's: there is
 * no per-sender OAuth scope Google offers (§4.3 — this was already true and
 * documented before any code existed), so the allowlist is enforced the same
 * two ways the design always intended: server-side, via Gmail's own search
 * query built from SENDER_ALLOWLIST (the equivalent of IMAP's `SEARCH FROM`
 * — non-matching mail is never listed, let alone fetched), and again inside
 * ingestEmail()'s classify() call on every message that does come back
 * (§4.4's substring-match close). The allowlist itself is still the one
 * constant in @job-digest/ingest/classify.ts — this module imports it rather
 * than repeating it.
 *
 * Scope cut, stated plainly: one page of up to 200 messages per run — fine
 * for a personal mailbox, easy to tighten once real usage shows what's
 * needed. The other scope cut this file used to carry (no incremental fetch;
 * every run re-scanned the last 90 days) is gone: found live as the reason
 * "Update now" was slow on every single click, not just the first — see
 * `since` below.
 */
import { decryptSecret } from '@job-digest/core/credentials';
import { mailboxes, runs } from '@job-digest/db';
import { eq, sql } from 'drizzle-orm';
import { SENDER_ALLOWLIST } from '@job-digest/ingest';
import { ingestEmail, type IngestResult } from './ingest-email';
import { enrichAd } from './enrich/enrich-ad';
import { withTenant, type Db } from './tenant';

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * neither order nor short-circuiting on the first rejection — each item's
 * own try/catch (in the caller) decides what a failure means, the same
 * tolerance the previous sequential loop had.
 */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_MESSAGES = 200;
const LOOKBACK_DAYS = 90;
/** How many messages to fetch+ingest concurrently. Gmail's own per-user rate limit is generous; this is about not opening dozens of DB transactions at once. */
const FETCH_CONCURRENCY = 5;
/**
 * Subtracted from the watermark before querying, so a run started at the
 * exact instant a message arrived — or a small clock skew between this
 * process and Gmail — cannot land on the wrong side of `after:` and skip it.
 * Message-id dedup in ingestEmail makes the resulting overlap free; this
 * value trades a handful of harmless re-fetches for that safety margin.
 */
const SYNC_SAFETY_BUFFER_MS = 60 * 60 * 1000;

/** Google refused to renew the connection — the refresh token is dead, not just this request. */
export class GmailAuthError extends Error {}

export function credentialKey(): Buffer {
  const b64 = process.env.MAILBOX_CREDENTIAL_KEY;
  if (!b64) throw new Error('MAILBOX_CREDENTIAL_KEY is not set (32 random bytes, base64)');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('MAILBOX_CREDENTIAL_KEY must decode to exactly 32 bytes');
  return key;
}

/**
 * "from:linkedin.com OR from:xing.com OR …", built from the one allowlist
 * constant (I14). With no watermark yet (first sync for this mailbox), falls
 * back to the fixed lookback window; otherwise bounds the search to
 * everything since the last successful run, which is what makes "Update now"
 * fast on the second and every later click instead of only the first.
 */
export function allowlistQuery(since?: Date): string {
  const domains = Object.values(SENDER_ALLOWLIST).flat();
  const senders = `(${domains.map((d) => `from:${d}`).join(' OR ')})`;
  if (!since) return `${senders} newer_than:${LOOKBACK_DAYS}d`;
  return `${senders} after:${Math.floor(since.getTime() / 1000)}`;
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET is not set');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    // invalid_grant is the specific, common case (Testing-mode 7-day expiry,
    // design §4.1) — surfaced distinctly so the caller can point the user at
    // reconnecting rather than a generic failure.
    const detail = await res.text();
    throw new GmailAuthError(`Google refused to renew the mailbox connection (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

/** Paginates up to MAX_MESSAGES ids matching the allowlist query — the fetch never runs unbounded. */
export async function listAllowlistedMessageIds(accessToken: string, since?: Date): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set('q', allowlistQuery(since));
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Gmail message list failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    for (const m of json.messages ?? []) ids.push(m.id);
    pageToken = json.nextPageToken;
  } while (pageToken && ids.length < MAX_MESSAGES);
  return ids.slice(0, MAX_MESSAGES);
}

/** The raw RFC822 bytes — same shape parseEml() already expects from a stored .eml file. */
export async function fetchRawMessage(accessToken: string, messageId: string): Promise<Buffer> {
  const url = new URL(`${GMAIL_API}/messages/${messageId}`);
  url.searchParams.set('format', 'raw');
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail message fetch failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { raw: string };
  return Buffer.from(json.raw, 'base64url');
}

export interface GmailIngestSummary {
  found: number;
  processed: number;
  created: number;
  failed: number;
}

/**
 * Decrypts the stored refresh token, refreshes an access token, lists and
 * fetches allowlisted messages, and runs each through the same
 * ingestEmail() every other acquisition path uses — one transaction per
 * email (design: "a failure never leaves an email recorded as parsed with
 * no ads"), so one bad message degrades the run instead of aborting it.
 *
 * Fetches up to FETCH_CONCURRENCY messages at once (previously strictly
 * sequential — the main reason "Update now" felt frozen) and only asks Gmail
 * for messages since `since`, when the mailbox has synced before — the other
 * reason it was slow: every click used to re-scan the last 90 days regardless
 * of whether the previous run had just finished them a minute earlier.
 *
 * `runs.emails_total`/`emails_processed` are updated as the run goes, not
 * only at the end — this is what lets the UI poll and show real progress
 * instead of an indeterminate spinner.
 *
 * Must run with the `worker` DB role (I13): mailboxCredentialsEnc is a
 * column app_user cannot even SELECT. Callers get this via @job-digest/db's
 * withTenant + worker role — see how packages/app calls this.
 */
export async function ingestFromGmail(
  db: Db,
  params: { userId: string; mailboxId: string; runId: string; credentialsEnc: Buffer; since?: Date | null },
): Promise<GmailIngestSummary> {
  const runStartedAt = new Date();
  const refreshToken = decryptSecret(params.credentialsEnc, credentialKey());
  const accessToken = await refreshAccessToken(refreshToken);
  const messageIds = await listAllowlistedMessageIds(accessToken, params.since ?? undefined);

  await withTenant(db, params.userId, (tx) =>
    tx.update(runs).set({ emailsTotal: messageIds.length }).where(eq(runs.id, params.runId)),
  );

  let processed = 0;
  let created = 0;
  let failed = 0;

  await mapWithConcurrency(messageIds, FETCH_CONCURRENCY, async (id) => {
    try {
      const raw = await fetchRawMessage(accessToken, id);
      const result: IngestResult = await withTenant(db, params.userId, (tx) =>
        ingestEmail(tx, { userId: params.userId, mailboxId: params.mailboxId, runId: params.runId, raw }),
      );
      processed++;
      created += result.adsCreated;
      // Tier 1 enrichment: fetch the original ad from Greenhouse/Lever API
      // post-transaction so network I/O doesn't hold the DB connection open.
      // Fire-and-forget per candidate — a failure is logged in enrichAd, not thrown.
      for (const c of result.enrichmentCandidates) {
        enrichAd(db, params.userId, c.adId, c.externalUrl).catch((err) =>
          console.error(`gmail enrich: ad ${c.adId} failed:`, err),
        );
      }
    } catch (err) {
      failed++;
      // One malformed/deleted message shouldn't abort the whole run — the
      // same reasoning as a single parse failure not emptying the digest.
      console.error(`gmail ingest: message ${id} failed:`, err);
    } finally {
      // Atomic increment, not read-modify-write: several of these run
      // concurrently under FETCH_CONCURRENCY, and a local counter written
      // back would lose updates under that overlap.
      await withTenant(db, params.userId, (tx) =>
        tx
          .update(runs)
          .set({ emailsProcessed: sql`${runs.emailsProcessed} + 1` })
          .where(eq(runs.id, params.runId)),
      );
    }
  });

  // Only reached if listing/auth succeeded — a thrown error above leaves the
  // watermark untouched, so a failed run gets retried from the same point
  // rather than silently advancing past mail it never actually fetched.
  await withTenant(db, params.userId, (tx) =>
    tx
      .update(mailboxes)
      .set({ lastSyncedAt: new Date(runStartedAt.getTime() - SYNC_SAFETY_BUFFER_MS) })
      .where(eq(mailboxes.id, params.mailboxId)),
  );

  return { found: messageIds.length, processed, created, failed };
}
