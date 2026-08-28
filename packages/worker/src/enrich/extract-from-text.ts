/**
 * LLM-based fact extraction from job posting plain text (ADR-003 Tier 1.5).
 *
 * Called after the structured API extraction (Tier 1) when a description is
 * available. Fills facts that the structured endpoints don't expose: shift
 * work, German requirement, onsite policy, contract type.
 *
 * Only sets a fact when the text explicitly states it — absence of a mention
 * is not inferred as "not required" (I4). Uses Haiku for speed and cost.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Facts, Level } from '@job-digest/core';

const MAX_TEXT_CHARS = 3_500;

interface ExtractedSignals {
  shift_work: boolean | null;
  weekend_work: boolean | null;
  german_level: string | null;
  onsite_only: boolean | null;
  permanent: boolean | null;
}

const VALID_LEVELS = new Set<Level>(['A2', 'B1', 'B2', 'C1', 'C2']);

function normalizeLevel(raw: string): Level | null {
  const upper = raw.trim().toUpperCase();
  if (VALID_LEVELS.has(upper as Level)) return upper as Level;
  // "Muttersprache" / "native" / "fluent" don't map to our Level enum.
  return null;
}

const PROMPT = `Extract job requirements from this posting excerpt. Only mark true/false when the posting *explicitly states* it — do not infer from silence.

Return ONLY valid JSON (no explanation, no markdown):
{"shift_work": null, "weekend_work": null, "german_level": null, "onsite_only": null, "permanent": null}

Fields:
- shift_work: true if rotating/shift/night work is required; false if explicitly excluded; null if not mentioned
- weekend_work: true if weekend work is required; false if explicitly excluded; null if not mentioned
- german_level: the required German level as a string (e.g. "B2", "C1", "Muttersprache") if stated; null otherwise
- onsite_only: true if fully onsite, no remote; false if fully remote; null if hybrid or not stated
- permanent: true if permanent/unbefristet/CDI; false if contract/freelance/befristet/CDD; null if not stated

Posting:`;

export async function extractFactsFromText(text: string): Promise<Partial<Facts>> {
  const excerpt = text.slice(0, MAX_TEXT_CHARS);

  const client = new Anthropic();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: `${PROMPT}\n\n${excerpt}` }],
  });

  const raw = msg.content[0];
  if (!raw || raw.type !== 'text') return {};

  let signals: ExtractedSignals;
  try {
    signals = JSON.parse(raw.text.trim()) as ExtractedSignals;
  } catch {
    return {};
  }

  const facts: Partial<Facts> = {};

  if (signals.shift_work === true) facts.rotating = true;
  if (signals.shift_work === false) facts.rotating = false;
  if (signals.weekend_work === true) facts.weekend = true;
  if (signals.weekend_work === false) facts.weekend = false;

  if (signals.german_level) {
    const level = normalizeLevel(signals.german_level);
    if (level) facts.german = level;
  }

  // home = days/week working from home; 0 = fully onsite, 5 = fully remote.
  if (signals.onsite_only === true) facts.home = 0;
  if (signals.onsite_only === false) facts.home = 5;

  if (signals.permanent === true) facts.permanent = true;
  if (signals.permanent === false) facts.permanent = false;

  return facts;
}
