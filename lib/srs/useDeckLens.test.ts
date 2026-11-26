/**
 * composeLensFrame — spec for what a manual deck shows on the G1 lens.
 *
 * The frame must track the on-screen reveal: prompt while recalling, prompt +
 * answer once revealed. No card → '' (nothing to push; the caller must not send
 * an empty frame). This is the formalised behaviour behind the Play-to-lens
 * mirror for study decks.
 */

import { composeLensFrame } from './useDeckLens';
import type { Card } from './card';

function card(prompt: string, answer: string): Card {
  // Only prompt/answer are read by composeLensFrame; the rest is scheduling
  // state the SRS engine owns and is irrelevant to the lens frame.
  return { prompt, answer } as Card;
}

describe('composeLensFrame', () => {
  it('shows the prompt alone while recalling', () => {
    expect(composeLensFrame(card('Capital of France?', 'Paris'), false))
      .toBe('Capital of France?');
  });

  it('shows prompt + answer once revealed, separated by a blank line', () => {
    expect(composeLensFrame(card('Capital of France?', 'Paris'), true))
      .toBe('Capital of France?\n\nParis');
  });

  it('returns empty string when there is no card (session done / empty deck)', () => {
    expect(composeLensFrame(null, false)).toBe('');
    expect(composeLensFrame(null, true)).toBe('');
  });

  it('preserves multi-line prompts and answers verbatim', () => {
    const c = card('Line 1\nLine 2', 'A1\nA2');
    expect(composeLensFrame(c, false)).toBe('Line 1\nLine 2');
    expect(composeLensFrame(c, true)).toBe('Line 1\nLine 2\n\nA1\nA2');
  });
});
