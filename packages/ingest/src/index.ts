export { SENDER_ALLOWLIST, classify, domainMatches, type ApiPlatform, type EmailPlatform, type Platform } from './classify';
export { declaredCount, type Declaration } from './declare';
export { dedupeKey, dedupeKeyFromStrings, externalId } from './dedupe';
export { findEmbeddedMessage, parseEml, type InboundEmail, type MimeParts } from './eml';
export { layoutHash } from './layout-hash';
export { normalizeWhitespace, verifyQuote } from './verify-quote';
export {
  normalizeAd,
  normalizeContract,
  normalizeEmployment,
  normalizeGerman,
  normalizePay,
  normalizeShift,
  normalizeWorkplace,
  type EmploymentFacts,
  type NormalizedAd,
  type PayFacts,
  type WorkplaceFacts,
} from './normalize/index';
export { extractTitleFacts } from './normalize/title-facts';
export {
  extractCvText,
  MAX_CV_BYTES,
  MAX_CV_PAGES,
  MIN_CV_TEXT_LENGTH,
  type CvExtraction,
  type CvExtractionFailure,
} from './cv-pdf';
export { extractorFor, registerExtractor, registeredExtractors } from './extract/registry';
export type { ExtractResult, ExtractedAd, Extractor, FieldSpan } from './extract/types';

// Built-in extractors register on import, explicitly and in one place.
import { linkedInCards } from './extract/linkedin';
import { stepstoneCards } from './extract/stepstone';
import { xingCards } from './extract/xing';
import { registerExtractor as register } from './extract/registry';
register(linkedInCards);
register(xingCards);
register(stepstoneCards);
export { linkedInCards, xingCards, stepstoneCards };
