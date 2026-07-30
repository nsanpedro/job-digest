/**
 * Extractor registry: (platform, layout_hash) → extractor, or an honest miss.
 * An unknown hash means we know we are blind before parsing (§5.3) — the
 * email is recorded as `unknown_layout`, never run through a guessing parser.
 */
import type { Platform } from '../classify';
import type { Extractor } from './types';

const extractors: Extractor[] = [];

export function registerExtractor(e: Extractor): void {
  extractors.push(e);
}

export function extractorFor(platform: Platform, layoutHash: string): Extractor | null {
  return (
    extractors.find((e) => e.platform === platform && e.layoutHashes.includes(layoutHash)) ?? null
  );
}

export function registeredExtractors(): readonly Extractor[] {
  return extractors;
}
