import type { RuleState } from '@job-digest/core';

/**
 * The four knockout states, transcribed from the design's `C` constant.
 * Deliberately desaturated (design: "the card average has 5 chips and cannot
 * look like a traffic light"). `unknown` is a first-class state, not a
 * fallback — its glyph and copy are as designed as the other three.
 */
export const STATE_VISUALS: Record<
  RuleState,
  { bg: string; fg: string; bd: string; glyph: string; label: string }
> = {
  pass: { bg: 'var(--pass-bg)', fg: 'var(--pass-fg)', bd: 'var(--pass-bd)', glyph: '✓', label: 'passes' },
  warn: { bg: 'var(--warn-bg)', fg: 'var(--warn-fg)', bd: 'var(--warn-bd)', glyph: '!', label: 'warning' },
  block: { bg: 'var(--block-bg)', fg: 'var(--block-fg)', bd: 'var(--block-bd)', glyph: '✕', label: 'excluded' },
  unknown: { bg: 'var(--unknown-bg)', fg: 'var(--unknown-fg)', bd: 'var(--unknown-bd)', glyph: '?', label: 'not read' },
};

export const EDGE_COLOR: Record<RuleState, string> = {
  pass: 'var(--pass-edge)',
  warn: 'var(--warn-edge)',
  block: 'var(--block-edge)',
  unknown: 'var(--unknown-edge)',
};

/** worst(kos) — block > warn > unknown > pass (design, "Derivados en renderVals()"). */
const RANK: Record<RuleState, number> = { pass: 0, unknown: 1, warn: 2, block: 3 };
export function worstOf(states: readonly RuleState[]): RuleState {
  return states.reduce<RuleState>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'pass');
}
