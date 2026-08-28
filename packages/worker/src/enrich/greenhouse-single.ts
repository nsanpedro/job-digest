/**
 * Fetch one Greenhouse job by board slug + job ID (ADR-003 Tier 1).
 * Same metadata-salary heuristic as the batch provider (providers/greenhouse.ts)
 * — kept in sync by sharing the same parse logic via normalizePay.
 *
 * Also returns the plain-text job description so the caller can run
 * LLM extraction for shift/German/onsite/contract (ADR-003 Tier 1.5).
 */
import { normalizePay } from '@job-digest/ingest';
import type { Facts } from '@job-digest/core';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

interface GreenhouseSingleJob {
  id: number;
  title: string;
  location: { name: string } | null;
  content: string | null;
  metadata: Array<{ name: string; value: string | null }> | null;
}

function extractPayFromMetadata(
  metadata: Array<{ name: string; value: string | null }> | null,
): string | null {
  if (!metadata) return null;
  const entry = metadata.find((m) => /salary|compensation|gehalt/i.test(m.name));
  return entry?.value ?? null;
}

export async function fetchGreenhouseJob(
  slug: string,
  jobId: string,
): Promise<{ facts: Partial<Facts>; descriptionText: string | null }> {
  const url = `${BASE}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Greenhouse API ${res.status} for ${slug}/${jobId}`);
  }

  const job = (await res.json()) as GreenhouseSingleJob;
  const facts: Partial<Facts> = {};

  const payText = extractPayFromMetadata(job.metadata);
  if (payText) {
    const parsed = normalizePay(payText);
    if (parsed) {
      facts.pay = parsed.pay;
      facts.payMax = parsed.payMax;
      facts.payFte = parsed.payFte;
      facts.fteNote = parsed.fteNote;
    }
  }

  const descriptionText = job.content ? stripHtml(job.content) : null;
  return { facts, descriptionText };
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
