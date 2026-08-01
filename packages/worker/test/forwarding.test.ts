/**
 * Forwarding verification (design §4.5), tested against the two real ways
 * mail clients forward mail — built from an actual LinkedIn fixture .eml
 * rather than hand-written headers, so the "embedded original" case is a
 * real message, not an invented shape.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyForwardedSender } from '../src/forwarding';

const fixturesDir = new URL('../../ingest/test/fixtures/linkedin', import.meta.url).pathname;
const linkedInFixture = (): Buffer => {
  const file = readdirSync(fixturesDir).find((f) => f.endsWith('.eml'))!;
  return readFileSync(join(fixturesDir, file));
};

/** A manual "Forward": new envelope from the forwarder, original wrapped as message/rfc822. */
function wrapAsManualForward(original: Buffer, forwarderAddr: string): Buffer {
  const boundary = 'forward-boundary-test';
  const headers = [
    `From: ${forwarderAddr}`,
    `To: u-abc123@in.example.com`,
    `Subject: Fwd: job alert`,
    `Date: Wed, 29 Jul 2026 09:00:00 +0000`,
    `Message-ID: <manual-forward@test>`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'FYI, check this out.',
    '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    original.toString('utf8'),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return Buffer.from(headers, 'utf8');
}

describe('verifyForwardedSender', () => {
  it('accepts a header-preserving auto-forward directly — the top-level From already clears the allowlist', async () => {
    const original = linkedInFixture();
    const verdict = await verifyForwardedSender(original);
    expect(verdict.accepted).toBe(true);
    expect(verdict.platform).toBe('LinkedIn');
    expect(verdict.raw?.equals(original)).toBe(true);
  });

  it('accepts a manual forward by finding the embedded original message', async () => {
    const original = linkedInFixture();
    const wrapped = wrapAsManualForward(original, 'ro@gmail.com');

    // The wrapper's own From is Ro's address — not allowlisted on its own.
    const wrapperVerdict = await verifyForwardedSender(wrapped);
    expect(wrapperVerdict.accepted).toBe(true);
    expect(wrapperVerdict.platform).toBe('LinkedIn');
    // What gets ingested is the unwrapped original, not the wrapper envelope.
    expect(wrapperVerdict.raw?.toString('utf8')).toContain('jobalerts-noreply@linkedin.com');
  });

  it('drops mail with no allowlisted sender anywhere, wrapped or not — nothing to ingest', async () => {
    const junk = Buffer.from(
      [
        'From: friend@example.com',
        'To: u-abc123@in.example.com',
        'Subject: check this out',
        'Date: Wed, 29 Jul 2026 09:00:00 +0000',
        'Message-ID: <junk@test>',
        'Content-Type: text/plain',
        '',
        'not a job alert',
      ].join('\r\n'),
      'utf8',
    );
    const verdict = await verifyForwardedSender(junk);
    expect(verdict.accepted).toBe(false);
    expect(verdict.raw).toBeNull();
  });

  it('drops a wrapped message whose embedded original is also not allowlisted', async () => {
    const innocentOriginal = Buffer.from(
      [
        'From: newsletter@example.com',
        'To: ro@gmail.com',
        'Subject: Weekly digest',
        'Date: Wed, 29 Jul 2026 08:00:00 +0000',
        'Message-ID: <inner@test>',
        'Content-Type: text/plain',
        '',
        'nothing relevant',
      ].join('\r\n'),
      'utf8',
    );
    const wrapped = wrapAsManualForward(innocentOriginal, 'ro@gmail.com');
    const verdict = await verifyForwardedSender(wrapped);
    expect(verdict.accepted).toBe(false);
    expect(verdict.raw).toBeNull();
  });
});
