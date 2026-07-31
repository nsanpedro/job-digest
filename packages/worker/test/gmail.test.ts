/**
 * Unit tests for the pure request/response shaping in gmail.ts, with fetch
 * mocked — the one place in this codebase that reasonably needs it. Every
 * other integration in the project tests against a real backend
 * (Testcontainers Postgres, real .eml fixtures); there is no self-hostable
 * equivalent of Gmail's API to run for real in CI. The actual live
 * verification is a real "Update now" click against a real inbox — these
 * tests only guard the parts that don't require one: the allowlist query
 * (I14 built from the one real constant), auth-error classification, and
 * base64url decoding.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allowlistQuery,
  fetchRawMessage,
  GmailAuthError,
  listAllowlistedMessageIds,
  refreshAccessToken,
} from '../src/gmail';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTH_GOOGLE_ID;
  delete process.env.AUTH_GOOGLE_SECRET;
});

describe('allowlistQuery', () => {
  it('is built from the one real SENDER_ALLOWLIST constant (I14), not a separate copy', () => {
    const q = allowlistQuery();
    expect(q).toContain('from:linkedin.com');
    expect(q).toContain('from:xing.com');
    expect(q).toContain('from:indeed.com');
    expect(q).toContain('from:stepstone.de');
    expect(q).toMatch(/^\(.*\) newer_than:\d+d$/);
  });
});

describe('refreshAccessToken', () => {
  it('posts client credentials and the refresh token, returns the access token', async () => {
    process.env.AUTH_GOOGLE_ID = 'client-id';
    process.env.AUTH_GOOGLE_SECRET = 'client-secret';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('client_id')).toBe('client-id');
      expect(body.get('refresh_token')).toBe('stored-refresh-token');
      expect(body.get('grant_type')).toBe('refresh_token');
      return new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await refreshAccessToken('stored-refresh-token');
    expect(token).toBe('fresh-token');
  });

  it('raises GmailAuthError (not a generic Error) when Google rejects the refresh token', async () => {
    process.env.AUTH_GOOGLE_ID = 'client-id';
    process.env.AUTH_GOOGLE_SECRET = 'client-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    );

    // GmailAuthError is what tells refreshDigest() to mark the mailbox
    // auth_failed instead of a generic internal error (design's error-kind
    // taxonomy) — the distinction has to survive as a real class, not just a
    // message string.
    await expect(refreshAccessToken('dead-token')).rejects.toBeInstanceOf(GmailAuthError);
  });

  it('fails loudly if the client id/secret env vars are missing, rather than sending an empty request', async () => {
    await expect(refreshAccessToken('x')).rejects.toThrow(/AUTH_GOOGLE_ID/);
  });
});

describe('listAllowlistedMessageIds', () => {
  it('follows pagination and stops once every page is consumed', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        call++;
        const s = String(url);
        expect(s).toContain('gmail.googleapis.com');
        expect(decodeURIComponent(s)).toContain('from:linkedin.com');
        if (call === 1) {
          return new Response(
            JSON.stringify({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ messages: [{ id: 'c' }] }), { status: 200 });
      }),
    );

    const ids = await listAllowlistedMessageIds('access-token');
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(call).toBe(2);
  });

  it('surfaces a clear error on a non-OK response rather than silently returning nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota exceeded', { status: 429 })));
    await expect(listAllowlistedMessageIds('access-token')).rejects.toThrow(/429/);
  });
});

describe('fetchRawMessage', () => {
  it('decodes the base64url raw field into the same byte shape a stored .eml has', async () => {
    const original = Buffer.from('From: jobalerts-noreply@linkedin.com\r\nSubject: test\r\n\r\nbody', 'utf8');
    const raw = original.toString('base64url');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        expect(String(url)).toContain('format=raw');
        return new Response(JSON.stringify({ raw }), { status: 200 });
      }),
    );

    const bytes = await fetchRawMessage('access-token', 'msg-1');
    expect(bytes.equals(original)).toBe(true);
  });
});
