/**
 * Fetch one Lever posting by slug + posting ID (ADR-003 Tier 1).
 * Same salary + commitment parsing as providers/lever.ts.
 *
 * Also returns plain-text description for LLM extraction (ADR-003 Tier 1.5)
 * and for `ads.description` (ADR-003 §8.x "Descriptions in matching") —
 * same sections, order and text shape as the batch provider (providers/lever.ts).
 */
import { normalizePay } from '@job-digest/ingest';
import type { Facts } from '@job-digest/core';
import { toStoredDescription } from '../providers/description';

const BASE = 'https://api.lever.co/v0/postings';

interface LeverSinglePosting {
  id: string;
  text: string;
  description: string | null;
  descriptionPlain: string | null;
  lists: Array<{ text: string; content: string }> | null;
  additional: string | null;
  additionalPlain?: string | null;
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

export async function fetchLeverPosting(
  slug: string,
  postingId: string,
): Promise<{ facts: Partial<Facts>; descriptionText: string | null }> {
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

  // Collect all description text: opening, list sections, closing.
  const lists = (posting.lists ?? []).flatMap((l) => [l.text, l.content]);
  const descriptionText = toStoredDescription(
    posting.descriptionPlain || posting.description,
    ...lists,
    posting.additionalPlain || posting.additional,
  );

  return { facts, descriptionText };
}
