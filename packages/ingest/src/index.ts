export { SENDER_ALLOWLIST, classify, domainMatches, type Platform } from './classify';
export { declaredCount, type Declaration } from './declare';
export { parseEml, type InboundEmail, type MimeParts } from './eml';
export { layoutHash } from './layout-hash';
export { normalizeWhitespace, verifyQuote } from './verify-quote';
export { extractorFor, registerExtractor, registeredExtractors } from './extract/registry';
export type { ExtractResult, ExtractedAd, Extractor, FieldSpan } from './extract/types';

// Built-in extractors register on import, explicitly and in one place.
import { linkedInCards } from './extract/linkedin';
import { xingCards } from './extract/xing';
import { registerExtractor as register } from './extract/registry';
register(linkedInCards);
register(xingCards);
export { linkedInCards, xingCards };
