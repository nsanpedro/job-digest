/**
 * Extraction contract (design §6.4). Deterministic, per-platform,
 * per-layout-hash. Every extracted field carries the source span it came
 * from — offsets are what make the I5 quote check verifiable, and they apply
 * identically to the LLM fallback: a model proposes spans, never text.
 */
import type { Platform } from '../classify';
import type { InboundEmail } from '../eml';

/** A field value plus where in the source it was read from. */
export interface FieldSpan {
  value: string;
  /** Offsets into the source named by `sourceKind`. */
  start: number;
  end: number;
  sourceKind: 'html' | 'text';
}

/** One ad as read from one email — strings only; normalization is a later stage (§6.5). */
export interface ExtractedAd {
  title?: FieldSpan;
  company?: FieldSpan;
  location?: FieldSpan;
  url?: FieldSpan;
  pay?: FieldSpan;
  workingTime?: FieldSpan;
  contract?: FieldSpan;
}

export interface ExtractResult {
  ads: ExtractedAd[];
  /** Field-level notes for email_parses.field_report (screen 2's right column). */
  fieldReport: Array<{ name: string; ok: boolean; value: string }>;
}

export interface Extractor {
  platform: Platform;
  /** Identifies this extractor in layouts.parser_id. */
  id: string;
  /** The layout hashes this extractor is known to handle (§5.3). */
  layoutHashes: readonly string[];
  extract(email: InboundEmail): ExtractResult;
}
