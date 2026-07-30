export { SENDER_ALLOWLIST, classify, domainMatches, type Platform } from './classify';
export { declaredCount, type Declaration } from './declare';
export { parseEml, type InboundEmail, type MimeParts } from './eml';
export { layoutHash } from './layout-hash';
export { normalizeWhitespace, verifyQuote } from './verify-quote';
export { extractorFor, registerExtractor, registeredExtractors } from './extract/registry';
export type { ExtractResult, ExtractedAd, Extractor, FieldSpan } from './extract/types';
