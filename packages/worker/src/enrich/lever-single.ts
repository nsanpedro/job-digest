/**
 * Fetch one Lever posting by slug + posting ID (ADR-003 Tier 1).
 * Same salary + commitment parsing as providers/lever.ts.
 */
import { normalizePay } from '@job-digest/ingest';
import type { Facts } from '@job-digest/core';

const BASE = 'https://api.lever.co/v0/postings';

interface LeverSinglePosting {
  id: string;
  text: string;
  categories: {
    commitment?: string;
  };
  salaryRange?: {
    min?: number;
    max?: number;
    currency?: string;
    interval?: string;
  };
}

export async function fetchLeverPosting(slug: string, postingId: string): Promise<Partial<Facts>> {
  const url = `${BASE}/${encodeURIComponent(slug)}/${encodeURIComponent(postingId)}?mode=json`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Lever API ${res.status} for ${slug}/${postingId}`);
  }

  const posting = (await res.json()) as LeverSinglePosting;
  const facts: Partial<Facts> = {};

  const sr = posting.salaryRange;
  if (sr && (sr.min ?? sr.max)) {
    const interval = sr.interval?.toLowerCase() ?? '';
    const isAnnual = interval.includes('year') || interval.includes('annual');
    const min = sr.min ?? 0;
    const max = sr.max ?? null;

    if (isAnnual) {
      facts.pay = Math.round(min / 12);
      facts.payMax = max !== null ? Math.round(max / 12) : null;
    } else {
      // Lever "per month" or unspecified — trust as-is; normalizePay handles
      // the magnitude heuristic the same way the batch provider does.
      const rangeText = max !== null ? `${min}-${max}` : String(min);
      const parsed = normalizePay(rangeText);
      if (parsed) {
        facts.pay = parsed.pay;
        facts.payMax = parsed.payMax;
      }
    }
  }

  const commitment = posting.categories.commitment?.toLowerCase() ?? '';
  if (commitment.includes('full')) {
    facts.permanent = null; // full-time ≠ permanent contract — not the same fact
  }
  if (commitment === 'contract') {
    facts.permanent = false;
  }

  // Lever does not expose shift or German level.

  return facts;
}
