/**
 * Fetch one Greenhouse job by board slug + job ID (ADR-003 Tier 1).
 * Same metadata-salary heuristic as the batch provider (providers/greenhouse.ts)
 * — kept in sync by sharing the same parse logic via normalizePay.
 */
import { normalizePay } from '@job-digest/ingest';
import type { Facts } from '@job-digest/core';

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

interface GreenhouseSingleJob {
  id: number;
  title: string;
  location: { name: string } | null;
  metadata: Array<{ name: string; value: string | null }> | null;
}

function extractPayFromMetadata(
  metadata: Array<{ name: string; value: string | null }> | null,
): string | null {
  if (!metadata) return null;
  const entry = metadata.find((m) => /salary|compensation|gehalt/i.test(m.name));
  return entry?.value ?? null;
}

export async function fetchGreenhouseJob(slug: string, jobId: string): Promise<Partial<Facts>> {
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

  // Greenhouse API does not expose shift, German level, or contract type.
  // Remaining fields stay absent (Partial<Facts>) — caller treats as "not found".

  return facts;
}
