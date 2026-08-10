/**
 * `deriveDirections` with the Anthropic SDK mocked — same convention
 * gmail.test.ts documents for Gmail: there is no self-hostable equivalent of
 * the Claude API to run for real in CI, so these tests guard the parts that
 * don't require a live key — request shape, refusal handling before
 * touching `content`, and that a response is always re-validated through
 * `parseDerivation` rather than trusted outright. They assert invariants,
 * never on what a real derivation would say about a real CV — that judgment
 * can only be made by actually running it, with a key, against a real CV
 * (ADR-001 §5.1 — "the actual test is Ro's CV").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

// Imported after the mock so the mocked module is what derive-directions.ts
// actually resolves — vi.mock is hoisted above imports by vitest, but being
// explicit about the order here is cheap and removes any doubt when reading it.
const { deriveDirections, MAX_AD_TITLES } = await import('../src/derive-directions');

function textResponse(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 1234, output_tokens: 567 },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  mockCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('credential boundary (I13)', () => {
  it('throws if ANTHROPIC_API_KEY is not set, rather than silently proceeding', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(deriveDirections({ cvText: 'CV text', adTitles: [] })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('refusal handling', () => {
  it('returns an empty, refused result without reading `content`', async () => {
    // `content` is a getter that throws if ever accessed — proves the
    // refusal branch really does check stop_reason first, the exact bug the
    // API docs warn a naive `content[0]` read would hit.
    mockCreate.mockResolvedValue({
      stop_reason: 'refusal',
      get content(): never {
        throw new Error('content was read on a refusal — this is the bug the check exists to prevent');
      },
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    const result = await deriveDirections({ cvText: 'CV text', adTitles: [] });
    expect(result).toMatchObject({ refused: true, skills: [], directions: [], dropped: [] });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
  });
});

describe('request shape', () => {
  it('calls claude-opus-5 with output_config.format bound to DERIVATION_SCHEMA, and no sampling params', async () => {
    mockCreate.mockResolvedValue(textResponse({ skills: [], directions: [] }));
    await deriveDirections({ cvText: 'CV text', adTitles: ['Frontend Developer'] });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0]![0];
    expect(call.model).toBe('claude-opus-5');
    expect(call.output_config.format.type).toBe('json_schema');
    expect(call.output_config.format.schema).toBeDefined();
    // These all 400 on Claude Opus 5 — asserting their absence is what
    // catches a future edit that reintroduces one by habit.
    expect(call.temperature).toBeUndefined();
    expect(call.top_p).toBeUndefined();
    expect(call.thinking).toBeUndefined();
  });

  it(`truncates ad titles to MAX_AD_TITLES (${MAX_AD_TITLES}) before they reach the prompt`, async () => {
    mockCreate.mockResolvedValue(textResponse({ skills: [], directions: [] }));
    const titles = Array.from({ length: MAX_AD_TITLES + 20 }, (_, i) => `Title ${i}`);
    await deriveDirections({ cvText: 'CV text', adTitles: titles });

    const call = mockCreate.mock.calls[0]![0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain('Title 0');
    expect(userMessage).toContain(`Title ${MAX_AD_TITLES - 1}`);
    expect(userMessage).not.toContain(`Title ${MAX_AD_TITLES}`);
  });
});

describe('response handling — always re-gated by parseDerivation, never trusted outright', () => {
  it('drops a skill whose quote is not actually in the CV, even though the model returned it', async () => {
    mockCreate.mockResolvedValue(
      textResponse({
        skills: [{ text: 'Python expert', quote: 'a decade of Python' }],
        directions: [],
      }),
    );
    const result = await deriveDirections({ cvText: 'This CV never mentions that language.', adTitles: [] });
    expect(result.skills).toEqual([]);
    expect(result.dropped.length).toBeGreaterThan(0);
  });

  it('keeps a skill whose quote is a real, verifiable span of the CV', async () => {
    mockCreate.mockResolvedValue(
      textResponse({
        skills: [{ text: 'audit prep', quote: 'five years of audit preparation' }],
        directions: [],
      }),
    );
    const result = await deriveDirections({
      cvText: 'Jane Doe has five years of audit preparation in a hospital lab.',
      adTitles: [],
    });
    expect(result.skills).toEqual([{ text: 'audit prep', quote: 'five years of audit preparation' }]);
  });

  it('degrades to an empty derivation, not a throw, when the model returns malformed JSON', async () => {
    mockCreate.mockResolvedValue(textResponse(null, { content: [{ type: 'text', text: 'not valid json {' }] }));
    const result = await deriveDirections({ cvText: 'CV text', adTitles: [] });
    expect(result.skills).toEqual([]);
    expect(result.directions).toEqual([]);
    expect(result.refused).toBe(false);
  });

  it('degrades to an empty derivation when the response has no text block at all', async () => {
    mockCreate.mockResolvedValue({
      stop_reason: 'end_turn',
      content: [],
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    const result = await deriveDirections({ cvText: 'CV text', adTitles: [] });
    expect(result.skills).toEqual([]);
    expect(result.directions).toEqual([]);
  });

  it('carries promptVersion and real token usage through on a normal response', async () => {
    mockCreate.mockResolvedValue(textResponse({ skills: [], directions: [] }));
    const result = await deriveDirections({ cvText: 'CV text', adTitles: [] });
    expect(result.promptVersion).toBeGreaterThanOrEqual(1);
    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 567 });
  });
});
