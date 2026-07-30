/**
 * Parse outcome classification (design §6, screen 2).
 *
 * This is I3 made executable: the count the email declared about itself is
 * the yardstick, and the gap between declared and extracted is what turns a
 * silent failure into a visible one. Every branch here corresponds to a
 * cause_code with authored, mechanism-naming copy — no branch may produce a
 * generic error.
 */
import type { Declaration, ExtractedAd, InboundEmail } from '@job-digest/ingest';

export type Outcome = 'ok' | 'partial' | 'none' | 'not_an_alert' | 'unknown_layout';
export type CauseCode =
  | 'layout_changed'
  | 'unknown_layout'
  | 'no_text_part'
  | 'unknown_block'
  | 'field_not_provided_by_platform'
  | 'not_an_alert'
  | null;

export interface OutcomeVerdict {
  outcome: Outcome;
  causeCode: CauseCode;
}

export function classifyOutcome(input: {
  email: InboundEmail;
  hasExtractor: boolean;
  declaration: Declaration;
  ads: ExtractedAd[];
}): OutcomeVerdict {
  const { email, hasExtractor, declaration, ads } = input;

  // The image-only email: nothing to read, and we do not read images.
  const imageOnly =
    !email.mimeParts.hasHtml &&
    !email.mimeParts.hasText &&
    email.mimeParts.attachmentTypes.some((t) => t.startsWith('image/'));
  if (imageOnly) return { outcome: 'none', causeCode: 'no_text_part' };
  if (!email.bodyHtml && !email.bodyText) {
    return { outcome: 'none', causeCode: 'no_text_part' };
  }

  // A layout we have never seen: we know we are blind before parsing (§5.3),
  // rather than reporting a confident zero.
  if (!hasExtractor) return { outcome: 'unknown_layout', causeCode: 'unknown_layout' };

  const declared = declaration.count;

  if (ads.length === 0) {
    // Nothing extracted and nothing claimed: a newsletter that matched on
    // sender. A successful outcome, not a failure — conflating the two would
    // make the failure count dishonest (§6.2).
    if (declared === null) return { outcome: 'not_an_alert', causeCode: 'not_an_alert' };
    // The email announced ads and we read none of them: the real hole.
    return { outcome: 'none', causeCode: 'unknown_block' };
  }

  // Coverage is unverifiable without a declaration — reported as such, never
  // as 100% (I3). Extracting something is still 'ok'; the null declaration is
  // carried on the row so screen 2 can say the count could not be checked.
  if (declared === null) return { outcome: 'ok', causeCode: null };

  if (ads.length < declared) return { outcome: 'partial', causeCode: 'unknown_block' };
  return { outcome: 'ok', causeCode: null };
}
