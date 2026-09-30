/**
 * URL-pattern detection for Tier 1 enrichment targets (ADR-003).
 * Returns null for anything we don't have a structured API for.
 */
import type { Tier1Match } from './types';

// `job-boards.greenhouse.io` is Greenhouse's current hosted-board domain
// (the classic `boards.` one still redirects); both are served by the same
// boards-api.greenhouse.io endpoints. The EU instance (`*.eu.greenhouse.io`)
// has its own API host and is deliberately not matched.
const GREENHOUSE_RE = /https?:\/\/(?:job-)?boards\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/;
const LEVER_RE = /https?:\/\/jobs\.lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/;

export function detectTier1(url: string): Tier1Match | null {
  const gh = GREENHOUSE_RE.exec(url);
  if (gh) return { platform: 'greenhouse', slug: gh[1]!, jobId: gh[2]! };

  const lv = LEVER_RE.exec(url);
  if (lv) return { platform: 'lever', slug: lv[1]!, postingId: lv[2]! };

  return null;
}
